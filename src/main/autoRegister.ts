/**
 * AWS Builder ID 自动注册模块
 * 完全集成在 Electron 中，不依赖外部 Python 脚本
 *
 * 邮箱参数格式: 邮箱|密码|refresh_token|client_id
 * - refresh_token: OAuth2 刷新令牌 (如 M.C509_xxx...)
 * - client_id: Graph API 客户端ID (如 9e5f94bc-xxx...)
 */

import { randomInt, createHmac } from "node:crypto";
import { chromium, Browser, Page, Locator } from "playwright";

// 日志回调类型
type LogCallback = (message: string) => void;

// 验证码正则表达式 - 与 Python 版本保持一致
const CODE_PATTERNS = [
  // AWS/Amazon 验证码格式
  /(?:verification\s*code|验证码|Your code is|code is)[：:\s]*(\d{6})/gi,
  /(?:is|为)[：:\s]*(\d{6})\b/gi,
  // 验证码通常单独一行或在特定上下文中
  /^\s*(\d{6})\s*$/gm, // 单独一行的6位数字
  />\s*(\d{6})\s*</g, // HTML标签之间的6位数字
];

// AWS 验证码发件人
const AWS_SENDERS = [
  "no-reply@signin.aws", // AWS 新发件人
  "no-reply@login.awsapps.com",
  "noreply@amazon.com",
  "account-update@amazon.com",
  "no-reply@aws.amazon.com",
  "noreply@aws.amazon.com",
  "aws", // 模糊匹配
];

// 随机姓名生成
const FIRST_NAMES = [
  "James",
  "Robert",
  "John",
  "Michael",
  "David",
  "William",
  "Richard",
  "Maria",
  "Elizabeth",
  "Jennifer",
  "Linda",
  "Barbara",
  "Susan",
  "Jessica",
];
const LAST_NAMES = [
  "Smith",
  "Johnson",
  "Williams",
  "Brown",
  "Jones",
  "Garcia",
  "Miller",
  "Davis",
  "Rodriguez",
  "Martinez",
  "Wilson",
  "Anderson",
  "Thomas",
  "Taylor",
];

const UPPERCASE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWERCASE_CHARS = "abcdefghijklmnopqrstuvwxyz";
const DIGIT_CHARS = "0123456789";
const PASSWORD_OPTIONAL_CHARS = UPPERCASE_CHARS + LOWERCASE_CHARS + DIGIT_CHARS;

export type HumanizationLevel = "low" | "medium" | "high";
type SessionTempo = "slow" | "normal" | "fast";
type RegionCode = "us" | "gb" | "de" | "fr" | "jp" | "sg" | "au";

type HumanizationProfile = {
  level: HumanizationLevel;
  tempo: SessionTempo;
  delayMultiplier: number;
  typingDelayMin: number;
  typingDelayMax: number;
  pauseEveryMin: number;
  pauseEveryMax: number;
  pauseDelayMin: number;
  pauseDelayMax: number;
  typoChancePercent: number;
  typoFixDelayMin: number;
  typoFixDelayMax: number;
  mouseCurveJitterX: number;
  mouseCurveJitterY: number;
  mouseFirstLegStepsMin: number;
  mouseFirstLegStepsMax: number;
  mouseSecondLegStepsMin: number;
  mouseSecondLegStepsMax: number;
  mouseSettleChancePercent: number;
  scrollNudgeChancePercent: number;
  scrollStrengthMultiplier: number;
  keyboardActionChancePercent: number;
  tabNavigationChancePercent: number;
  incidentalActionChancePercent: number;
  preHoverChancePercent: number;
  readingPauseMultiplier: number;
  warmUpChancePercent: number;
};

type SessionEnvironment = {
  regionCode: RegionCode;
  viewport: { width: number; height: number };
  locale: string;
  timezoneId: string;
  acceptLanguage: string;
  userAgent: string;
};

type HumanizationSession = {
  profile: HumanizationProfile;
  environment: SessionEnvironment;
};

function pickRandomChar(chars: string): string {
  return chars[randomInt(chars.length)];
}

function pickOne<T>(items: readonly T[]): T {
  return items[randomInt(items.length)];
}

function randomFloat(min: number, max: number): number {
  if (max <= min) {
    return min;
  }
  return min + Math.random() * (max - min);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function shuffleChars(chars: string[]): string[] {
  const shuffled = [...chars];

  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return shuffled;
}

function generateRandomName(): string {
  const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  return `${first} ${last}`;
}

function generateRandomPassword(length: number = 12): string {
  if (length < 4) {
    throw new Error("密码长度不能少于 4 位");
  }

  const passwordChars = [
    pickRandomChar(UPPERCASE_CHARS),
    pickRandomChar(LOWERCASE_CHARS),
    pickRandomChar(DIGIT_CHARS),
    "!",
  ];

  while (passwordChars.length < length) {
    passwordChars.push(pickRandomChar(PASSWORD_OPTIONAL_CHARS));
  }

  return shuffleChars(passwordChars).join("");
}

const DEFAULT_HUMANIZATION_PROFILE: HumanizationProfile = {
  level: "medium",
  tempo: "normal",
  delayMultiplier: 1,
  typingDelayMin: 45,
  typingDelayMax: 120,
  pauseEveryMin: 3,
  pauseEveryMax: 5,
  pauseDelayMin: 120,
  pauseDelayMax: 260,
  typoChancePercent: 5,
  typoFixDelayMin: 80,
  typoFixDelayMax: 180,
  mouseCurveJitterX: 70,
  mouseCurveJitterY: 55,
  mouseFirstLegStepsMin: 8,
  mouseFirstLegStepsMax: 16,
  mouseSecondLegStepsMin: 10,
  mouseSecondLegStepsMax: 22,
  mouseSettleChancePercent: 35,
  scrollNudgeChancePercent: 65,
  scrollStrengthMultiplier: 1,
  keyboardActionChancePercent: 22,
  tabNavigationChancePercent: 16,
  incidentalActionChancePercent: 20,
  preHoverChancePercent: 35,
  readingPauseMultiplier: 1,
  warmUpChancePercent: 80,
};

const pageProfiles = new WeakMap<Page, HumanizationProfile>();

const REGION_OPTIONS: Record<
  RegionCode,
  {
    locales: string[];
    timezones: string[];
    acceptLanguages: string[];
  }
> = {
  us: {
    locales: ["en-US"],
    timezones: [
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Los_Angeles",
    ],
    acceptLanguages: ["en-US,en;q=0.9", "en-US,en;q=0.8"],
  },
  gb: {
    locales: ["en-GB"],
    timezones: ["Europe/London"],
    acceptLanguages: ["en-GB,en;q=0.9", "en-GB,en-US;q=0.8,en;q=0.7"],
  },
  de: {
    locales: ["de-DE", "en-US"],
    timezones: ["Europe/Berlin"],
    acceptLanguages: ["de-DE,de;q=0.9,en;q=0.8", "en-US,en;q=0.9"],
  },
  fr: {
    locales: ["fr-FR", "en-US"],
    timezones: ["Europe/Paris"],
    acceptLanguages: ["fr-FR,fr;q=0.9,en;q=0.8", "en-US,en;q=0.9"],
  },
  jp: {
    locales: ["ja-JP", "en-US"],
    timezones: ["Asia/Tokyo"],
    acceptLanguages: ["ja-JP,ja;q=0.9,en;q=0.7", "en-US,en;q=0.9"],
  },
  sg: {
    locales: ["en-SG", "en-US"],
    timezones: ["Asia/Singapore"],
    acceptLanguages: ["en-SG,en;q=0.9", "en-US,en;q=0.9"],
  },
  au: {
    locales: ["en-AU", "en-US"],
    timezones: ["Australia/Sydney", "Australia/Perth"],
    acceptLanguages: ["en-AU,en;q=0.9", "en-US,en;q=0.9"],
  },
};

const COMMON_VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
];

const PROXY_REGION_PATTERNS: Array<{ region: RegionCode; patterns: RegExp[] }> = [
  {
    region: "us",
    patterns: [
      /(^|[\W_])us($|[\W_])/i,
      /usa|united.?states|new.?york|los.?angeles|dallas|miami/i,
    ],
  },
  {
    region: "gb",
    patterns: [/(^|[\W_])uk($|[\W_])/i, /(^|[\W_])gb($|[\W_])/i, /london|britain/i],
  },
  {
    region: "de",
    patterns: [/(^|[\W_])de($|[\W_])/i, /germany|berlin|frankfurt/i],
  },
  {
    region: "fr",
    patterns: [/(^|[\W_])fr($|[\W_])/i, /france|paris/i],
  },
  {
    region: "jp",
    patterns: [/(^|[\W_])jp($|[\W_])/i, /japan|tokyo|osaka/i],
  },
  {
    region: "sg",
    patterns: [/(^|[\W_])sg($|[\W_])/i, /singapore/i],
  },
  {
    region: "au",
    patterns: [/(^|[\W_])au($|[\W_])/i, /australia|sydney|melbourne|perth/i],
  },
];

function getHumanizationLabel(level: HumanizationLevel): string {
  if (level === "low") return "低";
  if (level === "high") return "高";
  return "中";
}

function pickSessionTempo(level: HumanizationLevel): SessionTempo {
  const roll = randomBetween(1, 100);
  if (level === "low") {
    if (roll <= 52) return "fast";
    if (roll <= 88) return "normal";
    return "slow";
  }
  if (level === "high") {
    if (roll <= 15) return "fast";
    if (roll <= 58) return "normal";
    return "slow";
  }
  if (roll <= 24) return "fast";
  if (roll <= 76) return "normal";
  return "slow";
}

function createHumanizationProfile(level: HumanizationLevel): HumanizationProfile {
  const tempo = pickSessionTempo(level);

  const tempoMultiplier =
    tempo === "slow"
      ? randomFloat(1.18, 1.42)
      : tempo === "fast"
        ? randomFloat(0.76, 0.95)
        : randomFloat(0.94, 1.12);

  const levelMultiplier =
    level === "low"
      ? randomFloat(0.86, 0.99)
      : level === "high"
        ? randomFloat(1.08, 1.24)
        : randomFloat(0.96, 1.08);

  const delayMultiplier = tempoMultiplier * levelMultiplier;

  let pauseEveryMin = tempo === "fast" ? 5 : tempo === "slow" ? 2 : 3;
  let pauseEveryMax = tempo === "fast" ? 7 : tempo === "slow" ? 4 : 5;
  if (level === "high") {
    pauseEveryMin = Math.max(2, pauseEveryMin - 1);
    pauseEveryMax = Math.max(pauseEveryMin, pauseEveryMax - 1);
  } else if (level === "low") {
    pauseEveryMin += 1;
    pauseEveryMax += 1;
  }

  const settingsByLevel: Record<
    HumanizationLevel,
    {
      typo: [number, number];
      keyboardAction: [number, number];
      tabNavigation: [number, number];
      incidental: [number, number];
      preHover: [number, number];
      readingMultiplier: [number, number];
      warmUpChance: [number, number];
      scrollChance: [number, number];
      scrollStrength: [number, number];
      mouseJitterX: [number, number];
      mouseJitterY: [number, number];
      firstLegSteps: [number, number];
      secondLegSteps: [number, number];
      settleChance: [number, number];
    }
  > = {
    low: {
      typo: [2, 4],
      keyboardAction: [10, 18],
      tabNavigation: [8, 14],
      incidental: [8, 16],
      preHover: [18, 28],
      readingMultiplier: [0.78, 0.98],
      warmUpChance: [60, 78],
      scrollChance: [48, 62],
      scrollStrength: [0.84, 1.04],
      mouseJitterX: [52, 72],
      mouseJitterY: [38, 58],
      firstLegSteps: [6, 12],
      secondLegSteps: [8, 18],
      settleChance: [20, 32],
    },
    medium: {
      typo: [4, 7],
      keyboardAction: [18, 28],
      tabNavigation: [14, 20],
      incidental: [16, 26],
      preHover: [30, 42],
      readingMultiplier: [0.94, 1.12],
      warmUpChance: [78, 90],
      scrollChance: [62, 76],
      scrollStrength: [0.95, 1.15],
      mouseJitterX: [62, 82],
      mouseJitterY: [46, 66],
      firstLegSteps: [8, 16],
      secondLegSteps: [10, 22],
      settleChance: [30, 42],
    },
    high: {
      typo: [7, 11],
      keyboardAction: [26, 40],
      tabNavigation: [20, 30],
      incidental: [28, 42],
      preHover: [42, 58],
      readingMultiplier: [1.12, 1.32],
      warmUpChance: [90, 98],
      scrollChance: [74, 88],
      scrollStrength: [1.08, 1.28],
      mouseJitterX: [74, 98],
      mouseJitterY: [56, 78],
      firstLegSteps: [10, 20],
      secondLegSteps: [14, 30],
      settleChance: [40, 56],
    },
  };

  const selected = settingsByLevel[level];

  return {
    level,
    tempo,
    delayMultiplier,
    typingDelayMin: clamp(Math.round(38 * delayMultiplier), 22, 140),
    typingDelayMax: clamp(Math.round(108 * delayMultiplier), 55, 220),
    pauseEveryMin,
    pauseEveryMax,
    pauseDelayMin: clamp(Math.round(95 * delayMultiplier), 70, 300),
    pauseDelayMax: clamp(Math.round(260 * delayMultiplier), 140, 560),
    typoChancePercent: randomBetween(selected.typo[0], selected.typo[1]),
    typoFixDelayMin: clamp(Math.round(70 * delayMultiplier), 55, 240),
    typoFixDelayMax: clamp(Math.round(160 * delayMultiplier), 95, 360),
    mouseCurveJitterX: randomBetween(selected.mouseJitterX[0], selected.mouseJitterX[1]),
    mouseCurveJitterY: randomBetween(selected.mouseJitterY[0], selected.mouseJitterY[1]),
    mouseFirstLegStepsMin: randomBetween(selected.firstLegSteps[0], selected.firstLegSteps[0] + 2),
    mouseFirstLegStepsMax: randomBetween(selected.firstLegSteps[1] - 2, selected.firstLegSteps[1]),
    mouseSecondLegStepsMin: randomBetween(selected.secondLegSteps[0], selected.secondLegSteps[0] + 3),
    mouseSecondLegStepsMax: randomBetween(selected.secondLegSteps[1] - 3, selected.secondLegSteps[1]),
    mouseSettleChancePercent: randomBetween(selected.settleChance[0], selected.settleChance[1]),
    scrollNudgeChancePercent: randomBetween(selected.scrollChance[0], selected.scrollChance[1]),
    scrollStrengthMultiplier: randomFloat(selected.scrollStrength[0], selected.scrollStrength[1]),
    keyboardActionChancePercent: randomBetween(selected.keyboardAction[0], selected.keyboardAction[1]),
    tabNavigationChancePercent: randomBetween(selected.tabNavigation[0], selected.tabNavigation[1]),
    incidentalActionChancePercent: randomBetween(selected.incidental[0], selected.incidental[1]),
    preHoverChancePercent: randomBetween(selected.preHover[0], selected.preHover[1]),
    readingPauseMultiplier: randomFloat(selected.readingMultiplier[0], selected.readingMultiplier[1]),
    warmUpChancePercent: randomBetween(selected.warmUpChance[0], selected.warmUpChance[1]),
  };
}

function getHumanizationProfile(page: Page): HumanizationProfile {
  return pageProfiles.get(page) ?? DEFAULT_HUMANIZATION_PROFILE;
}

function bindHumanizationProfile(page: Page, profile: HumanizationProfile): void {
  pageProfiles.set(page, profile);
}

function inferRegionFromProxy(proxyUrl?: string): RegionCode {
  if (!proxyUrl) {
    return "us";
  }

  let normalized = proxyUrl.toLowerCase();
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // ignore decode errors
  }

  for (const item of PROXY_REGION_PATTERNS) {
    if (item.patterns.some((pattern) => pattern.test(normalized))) {
      return item.region;
    }
  }
  return "us";
}

function buildRandomUserAgent(): string {
  const chromeVersion = `${randomBetween(124, 136)}.0.${randomBetween(6200, 7300)}.${randomBetween(50, 220)}`;

  if (chance(24)) {
    const macVersions = ["10_15_7", "11_7_10", "12_7_6", "13_6_9", "14_4_1"];
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X ${pickOne(macVersions)}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  }

  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

function createSessionEnvironment(proxyUrl?: string): SessionEnvironment {
  const regionCode = inferRegionFromProxy(proxyUrl);
  const regionOption = REGION_OPTIONS[regionCode];
  const baseViewport = pickOne(COMMON_VIEWPORTS);
  const viewport = {
    width: clamp(baseViewport.width + randomBetween(-28, 28), 1180, 1980),
    height: clamp(baseViewport.height + randomBetween(-20, 20), 700, 1180),
  };

  return {
    regionCode,
    viewport,
    locale: pickOne(regionOption.locales),
    timezoneId: pickOne(regionOption.timezones),
    acceptLanguage: pickOne(regionOption.acceptLanguages),
    userAgent: buildRandomUserAgent(),
  };
}

function createHumanizationSession(
  level: HumanizationLevel,
  proxyUrl?: string,
): HumanizationSession {
  return {
    profile: createHumanizationProfile(level),
    environment: createSessionEnvironment(proxyUrl),
  };
}

type Point = { x: number; y: number };

const mousePositions = new WeakMap<Page, Point>();

function randomBetween(min: number, max: number): number {
  if (max <= min) {
    return min;
  }

  return randomInt(min, max + 1);
}

function chance(percent: number): boolean {
  return randomFloat(0, 100) < percent;
}

async function waitRandom(
  page: Page,
  min: number,
  max: number,
  applyProfile: boolean = true,
): Promise<void> {
  let actualMin = min;
  let actualMax = max;

  if (applyProfile) {
    const { delayMultiplier } = getHumanizationProfile(page);
    actualMin = Math.max(10, Math.round(min * delayMultiplier));
    actualMax = Math.max(actualMin, Math.round(max * delayMultiplier));
  }

  await page.waitForTimeout(randomBetween(actualMin, actualMax));
}

function getViewportSize(page: Page): { width: number; height: number } {
  return page.viewportSize() ?? { width: 1280, height: 900 };
}

function getCurrentMousePosition(page: Page): Point {
  const existing = mousePositions.get(page);
  if (existing) {
    return existing;
  }

  const viewport = getViewportSize(page);
  return {
    x: randomBetween(80, Math.max(81, viewport.width - 80)),
    y: randomBetween(80, Math.max(81, viewport.height - 80)),
  };
}

function rememberMousePosition(page: Page, point: Point): void {
  mousePositions.set(page, point);
}

function getRandomPointInViewport(page: Page): Point {
  const viewport = getViewportSize(page);
  return {
    x: randomBetween(40, Math.max(41, viewport.width - 40)),
    y: randomBetween(60, Math.max(61, viewport.height - 60)),
  };
}

function getRandomPointInBox(box: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Point {
  const paddingX = Math.min(Math.max(4, box.width * 0.2), 16);
  const paddingY = Math.min(Math.max(4, box.height * 0.25), 12);

  const minX = Math.round(
    box.x + Math.min(paddingX, Math.max(1, box.width / 2)),
  );
  const maxX = Math.round(box.x + Math.max(box.width - paddingX, 1));
  const minY = Math.round(
    box.y + Math.min(paddingY, Math.max(1, box.height / 2)),
  );
  const maxY = Math.round(box.y + Math.max(box.height - paddingY, 1));

  return {
    x: randomBetween(minX, maxX),
    y: randomBetween(minY, maxY),
  };
}

async function moveMouseLikeUser(page: Page, target: Point): Promise<void> {
  const profile = getHumanizationProfile(page);
  const start = getCurrentMousePosition(page);
  const controlPoint = {
    x: Math.round(
      (start.x + target.x) / 2 +
        randomBetween(-profile.mouseCurveJitterX, profile.mouseCurveJitterX),
    ),
    y: Math.round(
      (start.y + target.y) / 2 +
        randomBetween(-profile.mouseCurveJitterY, profile.mouseCurveJitterY),
    ),
  };

  await page.mouse.move(controlPoint.x, controlPoint.y, {
    steps: randomBetween(
      profile.mouseFirstLegStepsMin,
      profile.mouseFirstLegStepsMax,
    ),
  });
  rememberMousePosition(page, controlPoint);
  await waitRandom(page, 30, 90);

  await page.mouse.move(target.x, target.y, {
    steps: randomBetween(
      profile.mouseSecondLegStepsMin,
      profile.mouseSecondLegStepsMax,
    ),
  });
  rememberMousePosition(page, target);

  if (chance(profile.mouseSettleChancePercent)) {
    const settlePoint = {
      x: target.x + randomBetween(-3, 3),
      y: target.y + randomBetween(-2, 2),
    };
    await page.mouse.move(settlePoint.x, settlePoint.y, {
      steps: randomBetween(2, 5),
    });
    rememberMousePosition(page, settlePoint);
  }
}

async function nudgeScrollLikeUser(
  page: Page,
  element?: Locator,
): Promise<void> {
  const profile = getHumanizationProfile(page);
  if (!chance(profile.scrollNudgeChancePercent)) {
    return;
  }

  let delta = 0;
  const viewport = getViewportSize(page);

  if (element) {
    const box = await element.boundingBox().catch(() => null);
    if (box) {
      const marginTop = box.y;
      const marginBottom = viewport.height - (box.y + box.height);

      if (marginTop > 220 && marginBottom > 220) {
        delta =
          chance(50)
            ? randomBetween(40, 120)
            : -randomBetween(40, 120);
      } else if (marginTop > 220) {
        delta = randomBetween(40, 120);
      } else if (marginBottom > 220) {
        delta = -randomBetween(40, 120);
      }
    }
  }

  if (!delta) {
    delta = chance(50) ? randomBetween(20, 70) : -randomBetween(20, 70);
  }

  delta = Math.round(delta * profile.scrollStrengthMultiplier);

  await page.mouse.wheel(0, delta);
  await waitRandom(page, 120, 260);

  if (Math.abs(delta) > 45 && chance(70)) {
    const correction =
      delta > 0 ? -randomBetween(15, 45) : randomBetween(15, 45);
    await page.mouse.wheel(0, correction);
    await waitRandom(page, 80, 180);
  }
}

async function focusElementLikeUser(
  page: Page,
  element: Locator,
): Promise<void> {
  await element.scrollIntoViewIfNeeded().catch(() => {});
  await waitRandom(page, 150, 320);
  await nudgeScrollLikeUser(page, element);

  const box = await element.boundingBox();
  if (box) {
    await moveMouseLikeUser(page, getRandomPointInBox(box));
    await waitRandom(page, 80, 200);
    await page.mouse.down();
    await waitRandom(page, 45, 110);
    await page.mouse.up();
    await waitRandom(page, 80, 180);
    return;
  }

  await element.click({ delay: randomBetween(50, 120) });
  await waitRandom(page, 80, 180);
}

async function typeTextLikeUser(page: Page, value: string): Promise<void> {
  const profile = getHumanizationProfile(page);

  const getTypoChar = (expected: string): string | null => {
    let pool = "";
    if (/[A-Z]/.test(expected)) {
      pool = UPPERCASE_CHARS;
    } else if (/[a-z]/.test(expected)) {
      pool = LOWERCASE_CHARS;
    } else if (/[0-9]/.test(expected)) {
      pool = DIGIT_CHARS;
    } else if (PASSWORD_OPTIONAL_CHARS.includes(expected)) {
      pool = PASSWORD_OPTIONAL_CHARS;
    }

    if (!pool) {
      return null;
    }

    for (let i = 0; i < 6; i++) {
      const typo = pickRandomChar(pool);
      if (typo !== expected) {
        return typo;
      }
    }
    return null;
  };

  for (let i = 0; i < value.length; i++) {
    const currentChar = value[i];
    const allowTypo = !/[\s@._-]/.test(currentChar);
    if (allowTypo && chance(profile.typoChancePercent)) {
      const typoChar = getTypoChar(currentChar);
      if (typoChar) {
        await page.keyboard.type(typoChar, {
          delay: randomBetween(profile.typingDelayMin, profile.typingDelayMax),
        });
        await waitRandom(
          page,
          profile.typoFixDelayMin,
          profile.typoFixDelayMax,
          false,
        );
        await page.keyboard.press("Backspace");
        await waitRandom(page, 60, 140);
      }
    }

    await page.keyboard.type(currentChar, {
      delay: randomBetween(profile.typingDelayMin, profile.typingDelayMax),
    });

    if (
      (i + 1) % randomBetween(profile.pauseEveryMin, profile.pauseEveryMax) ===
        0 &&
      i < value.length - 1
    ) {
      await waitRandom(
        page,
        profile.pauseDelayMin,
        profile.pauseDelayMax,
        false,
      );
    }
  }
}

async function performIncidentalAction(page: Page): Promise<void> {
  const profile = getHumanizationProfile(page);
  if (!chance(profile.incidentalActionChancePercent)) {
    return;
  }

  if (chance(58)) {
    await moveMouseLikeUser(page, getRandomPointInViewport(page));
    await waitRandom(page, 60, 180);
  }

  if (chance(42)) {
    await nudgeScrollLikeUser(page);
    await waitRandom(page, 80, 200);
  }
}

async function settleAfterInput(page: Page, element: Locator): Promise<void> {
  await waitRandom(page, 180, 360);
  await nudgeScrollLikeUser(page, element);

  await performIncidentalAction(page);

  const profile = getHumanizationProfile(page);

  if (chance(profile.tabNavigationChancePercent)) {
    await page.keyboard.press("Tab").catch(async () => {
      await element.blur().catch(() => {});
    });
  } else {
    await element.blur().catch(() => {});
  }
  await waitRandom(page, 80, 180);
}

async function estimatePageComplexity(page: Page): Promise<"light" | "medium" | "heavy"> {
  try {
    const [inputCount, buttonCount, linkCount, headingCount] = await Promise.all([
      page.locator("input, textarea, select").count(),
      page.locator("button, [role='button'], input[type='submit']").count(),
      page.locator("a").count(),
      page.locator("h1, h2, h3, [role='heading']").count(),
    ]);

    const score =
      inputCount * 1.5 + buttonCount * 1.1 + linkCount * 0.35 + headingCount * 0.6;
    if (score >= 46) return "heavy";
    if (score >= 22) return "medium";
    return "light";
  } catch {
    return "medium";
  }
}

async function pauseForReading(
  page: Page,
  hint: "navigation" | "transition" | "verification" | "form" = "transition",
): Promise<void> {
  const profile = getHumanizationProfile(page);
  const complexity = await estimatePageComplexity(page);

  let min = 450;
  let max = 1100;

  if (complexity === "medium") {
    min = 850;
    max = 1900;
  } else if (complexity === "heavy") {
    min = 1400;
    max = 3100;
  }

  if (hint === "verification") {
    min = Math.round(min * 1.24);
    max = Math.round(max * 1.32);
  } else if (hint === "form") {
    min = Math.round(min * 1.12);
    max = Math.round(max * 1.18);
  } else if (hint === "navigation") {
    min = Math.round(min * 0.85);
    max = Math.round(max * 0.92);
  }

  const pace = profile.delayMultiplier * profile.readingPauseMultiplier;
  await waitRandom(page, Math.round(min * pace), Math.round(max * pace), false);
}

async function warmUpPageInteraction(page: Page): Promise<void> {
  const profile = getHumanizationProfile(page);
  if (!chance(profile.warmUpChancePercent)) {
    return;
  }

  await waitRandom(page, 400, 900);
  await moveMouseLikeUser(page, getRandomPointInViewport(page));
  await waitRandom(page, 120, 240);
  await nudgeScrollLikeUser(page);
  await waitRandom(page, 200, 400);
  await pauseForReading(page, "navigation");
}

// HTML 转文本 - 改进版本
function htmlToText(html: string): string {
  if (!html) return "";

  let text = html;

  // 解码 HTML 实体
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) =>
      String.fromCharCode(parseInt(n, 16)),
    );

  // 移除 style 和 script 标签及其内容
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");

  // 将 br 和 p 标签转换为换行
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n");
  text = text.replace(/<\/div>/gi, "\n");

  // 移除所有 HTML 标签
  text = text.replace(/<[^>]+>/g, " ");

  // 清理多余空白
  text = text.replace(/\s+/g, " ");

  return text.trim();
}

// 从文本提取验证码 - 改进版本，与 Python 保持一致
function extractCode(text: string): string | null {
  if (!text) return null;

  for (const pattern of CODE_PATTERNS) {
    // 重置正则表达式的 lastIndex
    pattern.lastIndex = 0;

    let match;
    while ((match = pattern.exec(text)) !== null) {
      const code = match[1];
      if (code && /^\d{6}$/.test(code)) {
        // 获取上下文进行排除检查
        const start = Math.max(0, match.index - 20);
        const end = Math.min(text.length, match.index + match[0].length + 20);
        const context = text.slice(start, end);

        // 排除颜色代码 (#XXXXXX)
        if (context.includes("#" + code)) continue;

        // 排除 CSS 颜色相关
        if (/color[:\s]*[^;]*\d{6}/i.test(context)) continue;
        if (/rgb|rgba|hsl/i.test(context)) continue;

        // 排除超过6位的数字（电话号码、邮编等）
        if (/\d{7,}/.test(context)) continue;

        return code;
      }
    }
  }
  return null;
}

/**
 * 从 Outlook 邮箱获取验证码
 * 使用 Microsoft Graph API，与 Python 版本保持一致
 */
export async function getOutlookVerificationCode(
  refreshToken: string,
  clientId: string,
  log: LogCallback,
  timeout: number = 120,
): Promise<string | null> {
  log("========== 开始获取邮箱验证码 ==========");
  log(`client_id: ${clientId}`);
  log(`refresh_token: ${refreshToken.substring(0, 30)}...`);

  const startTime = Date.now();
  const checkInterval = 5000; // 5秒检查一次
  const checkedIds = new Set<string>();

  while (Date.now() - startTime < timeout * 1000) {
    try {
      // 刷新 access_token
      log("刷新 access_token...");
      let accessToken: string | null = null;

      const tokenAttempts = [
        {
          url: "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
          scope: "https://graph.microsoft.com/.default offline_access",
        },
        {
          url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
          scope: "https://graph.microsoft.com/.default offline_access",
        },
        {
          url: "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
          scope: "https://graph.microsoft.com/Mail.Read offline_access",
        },
        {
          url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
          scope: "https://graph.microsoft.com/Mail.Read offline_access",
        },
        {
          url: "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
          scope: null,
        },
        {
          url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
          scope: null,
        },
      ];

      for (const attempt of tokenAttempts) {
        try {
          const tokenBody = new URLSearchParams();
          tokenBody.append("client_id", clientId);
          tokenBody.append("refresh_token", refreshToken);
          tokenBody.append("grant_type", "refresh_token");
          if (attempt.scope) {
            tokenBody.append("scope", attempt.scope);
          }

          const tokenResponse = await fetch(attempt.url, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenBody.toString(),
          });
          const responseText = await tokenResponse.text();

          if (tokenResponse.ok) {
            let tokenResult: { access_token?: string } | null = null;
            try {
              tokenResult = JSON.parse(responseText) as {
                access_token?: string;
              };
            } catch {
              log(
                `token 响应不是合法 JSON，已忽略: ${responseText.substring(0, 120)}`,
              );
              continue;
            }

            const candidateToken = tokenResult.access_token?.trim() || "";
            if (!candidateToken) {
              log("token 响应缺少 access_token，已忽略");
              continue;
            }

            accessToken = candidateToken;
            log("✓ 成功获取 access_token");
            break;
          } else {
            log(
              `token 刷新失败(${tokenResponse.status}): ${responseText.substring(0, 200)}`,
            );
          }
        } catch {
          continue;
        }
      }

      if (!accessToken) {
        log("✗ token 刷新失败");
        return null;
      }

      // 获取邮件
      log("获取邮件列表...");
      const graphParams = new URLSearchParams({
        $top: "50",
        $orderby: "receivedDateTime desc",
        $select: "id,subject,from,receivedDateTime,bodyPreview,body",
      });

      const mailResponse = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages?${graphParams}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        },
      );

      if (!mailResponse.ok) {
        const errorText = await mailResponse.text();
        log(
          `获取邮件失败: ${mailResponse.status} ${errorText.substring(0, 200)}`,
        );
        await new Promise((r) => setTimeout(r, checkInterval));
        continue;
      }

      const mailData = (await mailResponse.json()) as {
        value: Array<{
          id: string;
          subject: string;
          from: { emailAddress: { address: string } };
          body: { content: string };
          bodyPreview: string;
          receivedDateTime: string;
        }>;
      };

      log(`获取到 ${mailData.value?.length || 0} 封邮件`);

      // 搜索最新的 AWS 邮件
      for (const mail of mailData.value || []) {
        const fromEmail = mail.from?.emailAddress?.address?.toLowerCase() || "";
        const isAwsSender = AWS_SENDERS.some((s) =>
          fromEmail.includes(s.toLowerCase()),
        );

        if (isAwsSender && !checkedIds.has(mail.id)) {
          checkedIds.add(mail.id);

          log(`\n=== 检查 AWS 邮件 ===`);
          log(`  发件人: ${fromEmail}`);
          log(`  主题: ${mail.subject?.substring(0, 50)}`);

          // 提取验证码
          let code: string | null = null;
          const bodyText = htmlToText(mail.body?.content || "");
          if (bodyText) {
            code = extractCode(bodyText);
          }
          if (!code) {
            code = extractCode(mail.body?.content || "");
          }
          if (!code) {
            code = extractCode(mail.bodyPreview || "");
          }

          if (code) {
            log(`\n========== 找到验证码: ${code} ==========`);
            return code;
          }
        }
      }

      log(`未找到验证码，${checkInterval / 1000}秒后重试...`);
      await new Promise((r) => setTimeout(r, checkInterval));
    } catch (error) {
      log(`获取验证码出错: ${error}`);
      await new Promise((r) => setTimeout(r, checkInterval));
    }
  }

  log("获取验证码超时");
  return null;
}

// ============================================================
// LuckMail OpenAPI（Mode A：按单收码）
// ============================================================

const LUCKMAIL_BASE = "https://mails.luckyous.com";

/** 生成 HMAC-SHA256 签名：method + path + timestamp + body */
function computeLuckMailSignature(
  apiKey: string,
  method: string,
  path: string,
  timestamp: number,
  body: string,
): string {
  const message = method.toUpperCase() + path + String(timestamp) + body;
  return createHmac("sha256", apiKey).update(message).digest("hex");
}

/** 构造带 HMAC 鉴权的请求头 */
function luckMailHeaders(
  apiKey: string,
  method: string,
  path: string,
  body: string,
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = computeLuckMailSignature(
    apiKey,
    method,
    path,
    timestamp,
    body,
  );
  return {
    "Content-Type": "application/json",
    "X-API-Key": apiKey,
    "X-Timestamp": String(timestamp),
    "X-Signature": signature,
  };
}

interface LuckMailOrder {
  orderNo: string;
  email: string;
}

interface LuckMailOrderCreateOptions {
  emailType?: string;
  domain?: string;
  specifiedEmail?: string;
}

/** 创建 LuckMail 订单，返回订单号和分配的邮箱地址 */
async function createLuckMailOrder(
  apiKey: string,
  projectCode: string,
  log: LogCallback,
  options?: LuckMailOrderCreateOptions,
): Promise<LuckMailOrder | null> {
  const path = "/api/v1/openapi/order/create";
  const bodyObj: {
    project_code: string;
    email_type?: string;
    domain?: string;
    specified_email?: string;
  } = { project_code: projectCode };
  if (options?.emailType?.trim()) {
    bodyObj.email_type = options.emailType.trim();
  }
  if (options?.domain?.trim()) {
    bodyObj.domain = options.domain.trim();
  }
  if (options?.specifiedEmail?.trim()) {
    bodyObj.specified_email = options.specifiedEmail.trim();
  }
  const bodyStr = JSON.stringify(bodyObj);
  const headers = luckMailHeaders(apiKey, "POST", path, bodyStr);

  try {
    const resp = await fetch(`${LUCKMAIL_BASE}${path}`, {
      method: "POST",
      headers,
      body: bodyStr,
    });
    const json = (await resp.json()) as {
      code: number;
      message: string;
      data: { order_no: string; email_address: string };
    };
    if (json.code === 0) {
      log(`✓ LuckMail 订单创建成功，邮箱: ${json.data.email_address}`);
      return { orderNo: json.data.order_no, email: json.data.email_address };
    } else {
      log(`✗ LuckMail 订单创建失败 (${json.code}): ${json.message}`);
      return null;
    }
  } catch (e) {
    log(`✗ LuckMail 订单创建出错: ${e}`);
    return null;
  }
}

/** 轮询 LuckMail 订单，直到获取到验证码或超时 */
async function getLuckMailCode(
  apiKey: string,
  orderNo: string,
  log: LogCallback,
  timeout: number = 120,
): Promise<string | null> {
  const startTime = Date.now();
  const checkInterval = 3000;

  log(`========== 开始轮询 LuckMail 验证码 (订单: ${orderNo}) ==========`);

  while (Date.now() - startTime < timeout * 1000) {
    const path = `/api/v1/openapi/order/${orderNo}/code`;
    const headers = luckMailHeaders(apiKey, "GET", path, "");

    try {
      const resp = await fetch(`${LUCKMAIL_BASE}${path}`, { headers });
      const json = (await resp.json()) as {
        code: number;
        message: string;
        data: {
          status: "pending" | "success" | "timeout" | "cancelled";
          verification_code?: string;
        };
      };

      if (json.code === 0) {
        const { status, verification_code } = json.data;
        log(`LuckMail 订单状态: ${status}`);
        if (status === "success" && verification_code) {
          log(`\n========== LuckMail 找到验证码: ${verification_code} ==========`);
          return verification_code;
        } else if (status === "timeout" || status === "cancelled") {
          log(`✗ LuckMail 订单已${status === "timeout" ? "超时" : "取消"}`);
          return null;
        }
        // pending → 继续轮询
      } else {
        log(`LuckMail 轮询响应 (${json.code}): ${json.message}`);
      }
    } catch (e) {
      log(`LuckMail 轮询出错: ${e}`);
    }

    await new Promise((r) => setTimeout(r, checkInterval));
  }

  log("LuckMail 获取验证码超时");
  return null;
}

/** 取消 LuckMail 订单（注册失败时清理） */
async function cancelLuckMailOrder(
  apiKey: string,
  orderNo: string,
  log: LogCallback,
): Promise<void> {
  const path = `/api/v1/openapi/order/${orderNo}/cancel`;
  const bodyStr = "{}";
  const headers = luckMailHeaders(apiKey, "POST", path, bodyStr);
  try {
    await fetch(`${LUCKMAIL_BASE}${path}`, {
      method: "POST",
      headers,
      body: bodyStr,
    });
    log(`✓ LuckMail 订单已取消: ${orderNo}`);
  } catch (e) {
    log(`⚠ LuckMail 订单取消失败: ${e}`);
  }
}

/**
 * 等待输入框出现并输入内容
 */
async function clearAndTypeIntoElement(
  page: Page,
  element: Locator,
  value: string,
): Promise<void> {
  const selectAllShortcut =
    process.platform === "darwin" ? "Meta+A" : "Control+A";
  await page.keyboard.press(selectAllShortcut).catch(() => {});
  await waitRandom(page, 50, 120);
  await page.keyboard.press("Backspace").catch(() => {});
  await waitRandom(page, 80, 180);
  await typeTextLikeUser(page, value);

  const currentValue = await element.inputValue().catch(() => "");
  if (currentValue !== value) {
    await element.fill(value);
  }
}

async function waitAndFill(
  page: Page,
  selector: string,
  value: string,
  log: LogCallback,
  description: string,
  timeout: number = 30000,
): Promise<boolean> {
  log(`等待${description}出现...`);
  try {
    const element = page.locator(selector).first();
    await element.waitFor({ state: "visible", timeout });
    await waitForElementEnabled(element, Math.min(timeout, 10000));
    await pauseForReading(page, "form");
    await focusElementLikeUser(page, element);
    await clearAndTypeIntoElement(page, element, value);

    await settleAfterInput(page, element);
    log(`✓ 已输入${description}: ${value}`);
    return true;
  } catch (error) {
    log(`✗ ${description}操作失败: ${error}`);
    return false;
  }
}

/**
 * 等待用户在浏览器中手动完成当前验证码步骤
 */
async function waitForManualVerification(
  page: Page,
  selector: string,
  log: LogCallback,
  description: string,
  timeout: number = 300000,
): Promise<boolean> {
  log(
    `请在浏览器窗口中手动输入${description}并点击 Continue，最长等待 ${Math.floor(timeout / 1000)} 秒...`,
  );
  try {
    await page.locator(selector).first().waitFor({ state: "hidden", timeout });
    log(`✓ 检测到${description}步骤已完成`);
    return true;
  } catch (error) {
    log(`✗ 等待手动完成${description}超时: ${error}`);
    return false;
  }
}

async function waitForElementEnabled(
  element: Locator,
  timeout: number = 10000,
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const isVisible = await element.isVisible();
      const isEnabled = await element.isEnabled();
      const ariaDisabled = await element.getAttribute("aria-disabled");

      if (isVisible && isEnabled && ariaDisabled !== "true") {
        return true;
      }
    } catch {
      void 0;
    }

    await new Promise((r) => setTimeout(r, 250));
  }

  return false;
}

async function clickLikeUser(
  page: Page,
  element: Locator,
  log: LogCallback,
  description: string,
): Promise<void> {
  const profile = getHumanizationProfile(page);
  await element.scrollIntoViewIfNeeded().catch(() => {});
  await waitRandom(page, 180, 360);
  await nudgeScrollLikeUser(page, element);

  const box = await element.boundingBox();
  if (box && chance(profile.preHoverChancePercent)) {
    const hoverPoint = {
      x: clamp(
        Math.round(box.x + box.width * randomFloat(0.2, 0.8) + randomBetween(-6, 6)),
        Math.round(box.x),
        Math.round(box.x + box.width),
      ),
      y: clamp(
        Math.round(box.y + box.height * randomFloat(0.25, 0.75) + randomBetween(-4, 4)),
        Math.round(box.y),
        Math.round(box.y + box.height),
      ),
    };
    await moveMouseLikeUser(page, hoverPoint);
    await waitRandom(page, 90, 220);
  }

  if (chance(profile.keyboardActionChancePercent)) {
    await element.focus().catch(() => {});
    await waitRandom(page, 80, 180);
    const key = chance(74) ? "Enter" : "Space";
    try {
      await page.keyboard.press(key);
      await waitRandom(page, 120, 260);
      log(`✓ 已用键盘(${key})触发${description}`);
      await performIncidentalAction(page);
      return;
    } catch {
      // 键盘触发失败时回退到鼠标点击
    }
  }

  if (box) {
    await moveMouseLikeUser(page, getRandomPointInBox(box));
    await waitRandom(page, 90, 220);
    await page.mouse.down();
    await waitRandom(page, 55, 140);
    await page.mouse.up();
    await waitRandom(page, 120, 260);
    log(`✓ 已用鼠标点击${description}`);
    await performIncidentalAction(page);
    return;
  }

  await element.click({ delay: randomBetween(60, 140) });
  await waitRandom(page, 120, 260);
  log(`✓ 已点击${description}`);
  await performIncidentalAction(page);
}

async function waitForAnyVisibleSelector(
  page: Page,
  selectors: string[],
  timeout: number = 30000,
): Promise<string | null> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    for (const selector of selectors) {
      try {
        if (await page.locator(selector).first().isVisible()) {
          return selector;
        }
      } catch {
        void 0;
      }
    }

    await waitRandom(page, 320, 620);
  }

  return null;
}

async function waitForCodeInputSelector(
  page: Page,
  selectors: string[],
  log: LogCallback,
  description: string,
  timeout: number = 30000,
): Promise<string | null> {
  log(`等待${description}出现...`);
  const matchedSelector = await waitForAnyVisibleSelector(page, selectors, timeout);
  if (!matchedSelector) {
    log(`✗ 未找到${description}`);
    return null;
  }

  log(`✓ ${description}已出现`);
  await pauseForReading(page, "verification");
  return matchedSelector;
}

async function waitAndClickWithFallback(
  page: Page,
  selectors: string[],
  log: LogCallback,
  description: string,
  timeout: number = 30000,
  maxRetries: number = 3,
): Promise<boolean> {
  for (let i = 0; i < selectors.length; i++) {
    const selector = selectors[i];
    const candidateDescription =
      selectors.length > 1 ? `${description}(候选 ${i + 1})` : description;

    if (
      await waitAndClickWithRetry(
        page,
        selector,
        log,
        candidateDescription,
        Math.max(5000, Math.floor(timeout / selectors.length)),
        maxRetries,
      )
    ) {
      return true;
    }
  }

  log(`✗ ${description}失败（未命中可用按钮）`);
  return false;
}

async function waitForManualClickAndAdvance(
  page: Page,
  nextStepSelectors: string[],
  log: LogCallback,
  description: string,
  timeout: number = 180000,
): Promise<boolean> {
  log(
    `自动点击${description}后页面未进入下一步，请在浏览器窗口中手动点击，最长等待 ${Math.floor(timeout / 1000)} 秒...`,
  );

  const matchedSelector = await waitForAnyVisibleSelector(
    page,
    nextStepSelectors,
    timeout,
  );
  if (matchedSelector) {
    log(`✓ 检测到你已手动完成${description}`);
    return true;
  }

  log(`✗ 等待手动完成${description}超时`);
  return false;
}

/**
 * 尝试多个选择器点击
 */
async function tryClickSelectors(
  page: Page,
  selectors: string[],
  log: LogCallback,
  description: string,
  timeout: number = 15000,
): Promise<boolean> {
  for (const selector of selectors) {
    try {
      const element = page.locator(selector).first();
      await element.waitFor({
        state: "visible",
        timeout: timeout / selectors.length,
      });
      await page.waitForTimeout(300);
      await waitForElementEnabled(element, 5000);
      await clickLikeUser(page, element, log, description);
      await pauseForReading(page, "transition");
      return true;
    } catch {
      continue;
    }
  }
  log(`✗ 未找到${description}`);
  return false;
}

/**
 * 检测 AWS 错误弹窗并重试点击按钮
 * 错误弹窗选择器: div.awsui_content_mx3cw_97dyn_391 包含 "抱歉，处理您的请求时出错"
 */
async function checkAndRetryOnError(
  page: Page,
  buttonSelector: string,
  log: LogCallback,
  description: string,
  maxRetries: number = 3,
  retryDelay: number = 2000,
): Promise<boolean> {
  // 错误弹窗的多种可能选择器
  const errorSelectors = [
    "div.awsui_content_mx3cw_97dyn_391",
    '[class*="awsui_content_"]',
    ".awsui-flash-error",
    '[data-testid="flash-error"]',
  ];

  const errorTexts = [
    "抱歉，处理您的请求时出错",
    "Sorry, there was an error processing your request",
    "error processing your request",
    "Please try again",
    "请重试",
  ];

  for (let retry = 0; retry < maxRetries; retry++) {
    // 等待一下让页面响应
    await waitRandom(page, 1200, 1800);

    // 检查是否有错误弹窗
    let hasError = false;
    for (const selector of errorSelectors) {
      try {
        const errorElements = await page.locator(selector).all();
        for (const el of errorElements) {
          const text = await el.textContent();
          if (text && errorTexts.some((errText) => text.includes(errText))) {
            hasError = true;
            log(`⚠ 检测到错误弹窗: "${text.substring(0, 50)}..."`);
            break;
          }
        }
        if (hasError) break;
      } catch {
        continue;
      }
    }

    if (!hasError) {
      // 没有错误，操作成功
      return true;
    }

    if (retry < maxRetries - 1) {
      log(`重试点击${description} (${retry + 2}/${maxRetries})...`);
      await waitRandom(
        page,
        Math.max(200, retryDelay - 300),
        retryDelay + 400,
      );

      // 重新点击按钮
      try {
        const button = page.locator(buttonSelector).first();
        await button.waitFor({ state: "visible", timeout: 5000 });
        await waitForElementEnabled(button, 5000);
        await clickLikeUser(page, button, log, description);
        await pauseForReading(page, "transition");
      } catch (e) {
        log(`✗ 重新点击${description}失败: ${e}`);
      }
    }
  }

  log(`✗ ${description}多次重试后仍然失败`);
  return false;
}

/**
 * 等待按钮出现并点击，带错误检测和自动重试
 */
async function waitAndClickWithRetry(
  page: Page,
  selector: string,
  log: LogCallback,
  description: string,
  timeout: number = 30000,
  maxRetries: number = 3,
): Promise<boolean> {
  log(`等待${description}出现...`);
  try {
    const element = page.locator(selector).first();
    await element.waitFor({ state: "visible", timeout });
    await waitForElementEnabled(element, Math.min(timeout, 10000));
    await clickLikeUser(page, element, log, description);
    await pauseForReading(page, "transition");

    // 检查是否有错误弹窗，如果有则重试
    const success = await checkAndRetryOnError(
      page,
      selector,
      log,
      description,
      maxRetries,
    );
    return success;
  } catch (error) {
    log(`✗ 点击${description}失败: ${error}`);
    return false;
  }
}

/**
 * Outlook 邮箱激活
 * 在 AWS 注册之前激活 Outlook 邮箱，确保能正常接收验证码
 */
export async function activateOutlook(
  email: string,
  emailPassword: string,
  log: LogCallback,
  headless: boolean = false,
  humanizationLevel: HumanizationLevel = "medium",
): Promise<{ success: boolean; error?: string }> {
  const activationUrl = "https://go.microsoft.com/fwlink/p/?linkid=2125442";
  let browser: Browser | null = null;
  const humanizationSession = createHumanizationSession(humanizationLevel);

  log("========== 开始激活 Outlook 邮箱 ==========");
  log(`邮箱: ${email}`);
  log(
    `拟人化强度: ${getHumanizationLabel(humanizationLevel)} (节奏: ${humanizationSession.profile.tempo})`,
  );

  try {
    // 启动浏览器
    log("\n步骤1: 启动浏览器，访问 Outlook 激活页面...");
    browser = await chromium.launch({
      headless,
      args: ["--disable-blink-features=AutomationControlled"],
    });

    const context = await browser.newContext({
      viewport: humanizationSession.environment.viewport,
      userAgent: humanizationSession.environment.userAgent,
      locale: humanizationSession.environment.locale,
      timezoneId: humanizationSession.environment.timezoneId,
      extraHTTPHeaders: {
        "Accept-Language": humanizationSession.environment.acceptLanguage,
      },
    });

    const page = await context.newPage();
    bindHumanizationProfile(page, humanizationSession.profile);

    await page.goto(activationUrl, {
      waitUntil: "networkidle",
      timeout: 60000,
    });
    log("✓ 页面加载完成");
    log(
      `会话环境: ${humanizationSession.environment.viewport.width}x${humanizationSession.environment.viewport.height}, ${humanizationSession.environment.locale}, ${humanizationSession.environment.timezoneId}`,
    );
    await page.waitForTimeout(2000);
    await warmUpPageInteraction(page);
    await pauseForReading(page, "navigation");

    // 步骤2: 等待邮箱输入框出现并输入邮箱
    log("\n步骤2: 输入邮箱...");
    const emailInputSelectors = [
      'input#i0116[type="email"]',
      'input[name="loginfmt"]',
      'input[type="email"]',
    ];

    let emailFilled = false;
    for (const selector of emailInputSelectors) {
      try {
        const element = page.locator(selector).first();
        await element.waitFor({ state: "visible", timeout: 10000 });
        await focusElementLikeUser(page, element);
        await clearAndTypeIntoElement(page, element, email);
        await settleAfterInput(page, element);
        log(`✓ 已输入邮箱: ${email}`);
        emailFilled = true;
        break;
      } catch {
        continue;
      }
    }

    if (!emailFilled) {
      throw new Error("未找到邮箱输入框");
    }

    await page.waitForTimeout(1000);

    // 步骤3: 点击第一个下一步按钮
    log("\n步骤3: 点击下一步按钮...");
    const firstNextSelectors = [
      'input#idSIButton9[type="submit"]',
      'input[type="submit"][value="下一步"]',
      'input[type="submit"][value="Next"]',
    ];

    if (
      !(await tryClickSelectors(
        page,
        firstNextSelectors,
        log,
        "第一个下一步按钮",
      ))
    ) {
      throw new Error("点击第一个下一步按钮失败");
    }

    await page.waitForTimeout(3000);

    // 步骤4: 等待密码输入框出现并输入密码
    log("\n步骤4: 输入密码...");
    const passwordInputSelectors = [
      'input#passwordEntry[type="password"]',
      'input#i0118[type="password"]',
      'input[name="passwd"][type="password"]',
      'input[type="password"]',
    ];

    let passwordFilled = false;
    for (const selector of passwordInputSelectors) {
      try {
        const element = page.locator(selector).first();
        await element.waitFor({ state: "visible", timeout: 15000 });
        await focusElementLikeUser(page, element);
        await clearAndTypeIntoElement(page, element, emailPassword);
        await settleAfterInput(page, element);
        log("✓ 已输入密码");
        passwordFilled = true;
        break;
      } catch {
        continue;
      }
    }

    if (!passwordFilled) {
      throw new Error("未找到密码输入框");
    }

    await page.waitForTimeout(1000);

    // 步骤5: 点击第二个下一步/登录按钮
    log("\n步骤5: 点击登录按钮...");
    const loginButtonSelectors = [
      'button[type="submit"][data-testid="primaryButton"]',
      'input#idSIButton9[type="submit"]',
      'button:has-text("下一步")',
      'button:has-text("登录")',
      'button:has-text("Sign in")',
      'button:has-text("Next")',
    ];

    if (
      !(await tryClickSelectors(page, loginButtonSelectors, log, "登录按钮"))
    ) {
      throw new Error("点击登录按钮失败");
    }

    await page.waitForTimeout(3000);

    // 步骤6: 等待第一个"暂时跳过"链接并点击
    log('\n步骤6: 点击第一个"暂时跳过"链接...');
    const skipSelector = "a#iShowSkip";
    try {
      const skipElement = page.locator(skipSelector).first();
      await skipElement.waitFor({ state: "visible", timeout: 30000 });
      await clickLikeUser(page, skipElement, log, '第一个"暂时跳过"链接');
      await pauseForReading(page, "transition");
      log('✓ 已点击第一个"暂时跳过"');
      await page.waitForTimeout(3000);
    } catch {
      log('未找到第一个"暂时跳过"链接，可能已跳过此步骤');
    }

    // 步骤7: 等待第二个"暂时跳过"链接并点击
    log('\n步骤7: 点击第二个"暂时跳过"链接...');
    try {
      const skipElement = page.locator(skipSelector).first();
      await skipElement.waitFor({ state: "visible", timeout: 15000 });
      await clickLikeUser(page, skipElement, log, '第二个"暂时跳过"链接');
      await pauseForReading(page, "transition");
      log('✓ 已点击第二个"暂时跳过"');
      await page.waitForTimeout(3000);
    } catch {
      log('未找到第二个"暂时跳过"链接，可能已跳过此步骤');
    }

    // 步骤8: 等待"取消"按钮（密钥创建对话框）并点击
    log('\n步骤8: 点击"取消"按钮（跳过密钥创建）...');
    const cancelButtonSelectors = [
      'button[data-testid="secondaryButton"]:has-text("取消")',
      'button[data-testid="secondaryButton"]:has-text("Cancel")',
      'button[type="button"]:has-text("取消")',
      'button[type="button"]:has-text("Cancel")',
    ];

    if (
      !(await tryClickSelectors(
        page,
        cancelButtonSelectors,
        log,
        '"取消"按钮',
        15000,
      ))
    ) {
      log('未找到"取消"按钮，可能已跳过此步骤');
    }

    await page.waitForTimeout(3000);

    // 步骤9: 等待"是"按钮（保持登录状态）并点击
    log('\n步骤9: 点击"是"按钮（保持登录状态）...');
    const yesButtonSelectors = [
      'button[type="submit"][data-testid="primaryButton"]:has-text("是")',
      'button[type="submit"][data-testid="primaryButton"]:has-text("Yes")',
      'input#idSIButton9[value="是"]',
      'input#idSIButton9[value="Yes"]',
      'button:has-text("是")',
      'button:has-text("Yes")',
    ];

    if (
      !(await tryClickSelectors(
        page,
        yesButtonSelectors,
        log,
        '"是"按钮',
        15000,
      ))
    ) {
      log('未找到"是"按钮，可能已跳过此步骤');
    }

    await page.waitForTimeout(5000);

    // 步骤10: 等待 Outlook 邮箱加载完成
    log("\n步骤10: 等待 Outlook 邮箱加载完成...");
    const newMailSelectors = [
      'button[aria-label="New mail"]',
      'button:has-text("New mail")',
      'button:has-text("新邮件")',
      'span:has-text("New mail")',
      '[data-automation-type="RibbonSplitButton"]',
    ];

    let outlookLoaded = false;
    for (const selector of newMailSelectors) {
      try {
        const element = page.locator(selector).first();
        await element.waitFor({ state: "visible", timeout: 30000 });
        log("✓ Outlook 邮箱激活成功！");
        outlookLoaded = true;
        break;
      } catch {
        continue;
      }
    }

    if (!outlookLoaded) {
      // 检查是否已经在收件箱页面
      const currentUrl = page.url();
      if (
        currentUrl.toLowerCase().includes("outlook") ||
        currentUrl.toLowerCase().includes("mail")
      ) {
        log("✓ 已进入 Outlook 邮箱页面，激活成功！");
        outlookLoaded = true;
      }
    }

    await page.waitForTimeout(2000);
    await browser.close();
    browser = null;

    if (outlookLoaded) {
      log("\n========== Outlook 邮箱激活完成 ==========");
      return { success: true };
    } else {
      log("\n⚠ Outlook 邮箱激活可能未完成");
      return { success: false, error: "Outlook 邮箱激活可能未完成" };
    }
  } catch (error) {
    log(`\n✗ Outlook 激活失败: ${error}`);
    if (browser) {
      try {
        await browser.close();
      } catch {
        void 0;
      }
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * AWS Builder ID 自动注册
 * @param email 邮箱地址
 * @param refreshToken OAuth2 刷新令牌
 * @param clientId Graph API 客户端ID
 * @param log 日志回调
 * @param emailPassword 邮箱密码（用于 Outlook 激活）
 * @param skipOutlookActivation 是否跳过 Outlook 激活
 * @param proxyUrl 代理地址（仅用于 AWS 注册，不用于 Outlook 激活和获取验证码）
 * @param manualVerification 是否手动输入验证码
 * @param headless 是否无头模式（手动验证码模式下会强制关闭）
 * @param humanizationLevel 拟人化强度（低/中/高）
 */
export async function autoRegisterAWS(
  email: string,
  refreshToken: string,
  clientId: string,
  log: LogCallback,
  emailPassword?: string,
  skipOutlookActivation: boolean = false,
  proxyUrl?: string,
  manualVerification: boolean = false,
  headless: boolean = false,
  humanizationLevel: HumanizationLevel = "medium",
  luckMailConfig?: {
    apiKey: string;
    projectCode: string;
    emailType?: string;
    domain?: string;
    specifiedEmail?: string;
  },
): Promise<{
  success: boolean;
  ssoToken?: string;
  name?: string;
  email?: string;
  error?: string;
}> {
  const password = generateRandomPassword(12);
  const randomName = generateRandomName();
  let browser: Browser | null = null;
  const useHeadless = manualVerification ? false : headless;
  const humanizationSession = createHumanizationSession(
    humanizationLevel,
    proxyUrl,
  );

  if (manualVerification && headless) {
    log("⚠ 手动验证码模式不支持无头，已自动切换为有头模式");
  }

  // LuckMail Mode A：创建订单，由平台分配邮箱
  let resolvedEmail = email;
  let luckMailOrderNo: string | null = null;
  if (luckMailConfig) {
    log("========== LuckMail Mode A：创建订单获取邮箱 ==========");
    const order = await createLuckMailOrder(
      luckMailConfig.apiKey,
      luckMailConfig.projectCode,
      log,
      {
        emailType: luckMailConfig.emailType,
        domain: luckMailConfig.domain,
        specifiedEmail: luckMailConfig.specifiedEmail,
      },
    );
    if (!order) {
      return { success: false, error: "LuckMail 订单创建失败" };
    }
    resolvedEmail = order.email;
    luckMailOrderNo = order.orderNo;
    // LuckMail 模式下跳过 Outlook 激活
    skipOutlookActivation = true;
  }

  // 如果是 Outlook 邮箱且提供了密码，先激活（不使用代理）
  if (
    !skipOutlookActivation &&
    resolvedEmail.toLowerCase().includes("outlook") &&
    emailPassword
  ) {
    log("检测到 Outlook 邮箱，先进行激活（不使用代理）...");
    const activationResult = await activateOutlook(
      resolvedEmail,
      emailPassword,
      log,
      useHeadless,
      humanizationLevel,
    );
    if (!activationResult.success) {
      log(`⚠ Outlook 激活可能未完成: ${activationResult.error}`);
      log("继续尝试 AWS 注册...");
    } else {
      log("Outlook 激活成功，开始 AWS 注册...");
    }
    // 等待一下再继续
    await new Promise((r) => setTimeout(r, 2000));
  }

  log("========== 开始 AWS Builder ID 注册 ==========");
  log(`邮箱: ${resolvedEmail}`);
  log(`姓名: ${randomName}`);
  log(`密码: ${password}`);
  if (proxyUrl) {
    log(`代理: ${proxyUrl}`);
  }
  log(`浏览器模式: ${useHeadless ? "无头" : "有头"}`);
  log(
    `拟人化强度: ${getHumanizationLabel(humanizationLevel)} (节奏: ${humanizationSession.profile.tempo})`,
  );

  try {
    // 步骤1: 创建浏览器，进入注册页面（使用代理）
    log("\n步骤1: 启动浏览器，进入注册页面...");
    browser = await chromium.launch({
      headless: useHeadless,
      proxy: proxyUrl ? { server: proxyUrl } : undefined,
      args: ["--disable-blink-features=AutomationControlled"],
    });

    const context = await browser.newContext({
      viewport: humanizationSession.environment.viewport,
      userAgent: humanizationSession.environment.userAgent,
      locale: humanizationSession.environment.locale,
      timezoneId: humanizationSession.environment.timezoneId,
      extraHTTPHeaders: {
        "Accept-Language": humanizationSession.environment.acceptLanguage,
      },
    });

    const page = await context.newPage();
    bindHumanizationProfile(page, humanizationSession.profile);

    const registerUrl =
      "https://view.awsapps.com/start/#/device?user_code=PQCF-FCCN";
    await page.goto(registerUrl, { waitUntil: "networkidle", timeout: 60000 });
    log("✓ 页面加载完成");
    log(
      `会话环境: ${humanizationSession.environment.viewport.width}x${humanizationSession.environment.viewport.height}, ${humanizationSession.environment.locale}, ${humanizationSession.environment.timezoneId}, region=${humanizationSession.environment.regionCode}`,
    );
    await page.waitForTimeout(2000);
    await warmUpPageInteraction(page);
    await pauseForReading(page, "navigation");

    // 等待邮箱输入框出现并输入邮箱
    // 选择器: input[placeholder="username@example.com"]
    const emailInputSelector = 'input[placeholder="username@example.com"]';
    if (
      !(await waitAndFill(page, emailInputSelector, resolvedEmail, log, "邮箱输入框"))
    ) {
      throw new Error("未找到邮箱输入框");
    }

    await page.waitForTimeout(1000);

    // 点击第一个继续按钮（带错误检测和自动重试）
    // 选择器: button[data-testid="test-primary-button"]
    const firstContinueSelector = 'button[data-testid="test-primary-button"]';
    if (
      !(await waitAndClickWithRetry(
        page,
        firstContinueSelector,
        log,
        "第一个继续按钮",
      ))
    ) {
      throw new Error("点击第一个继续按钮失败");
    }

    await page.waitForTimeout(3000);

    // 检测是否是已注册账号（登录页面或验证页面）
    // 登录页面标识1: span 包含 "Sign in with your AWS Builder ID"
    // 登录页面标识2: 页面包含 "verify" 字样且有验证码输入框
    const loginHeadingSelector =
      'span[class*="awsui_heading-text"]:has-text("Sign in with your AWS Builder ID")';
    const verifyHeadingSelector =
      'span[class*="awsui_heading-text"]:has-text("Verify")';
    const verifyCodeInputSelector = 'input[placeholder="6-digit"]';
    const nameInputSelector = 'input[placeholder="Maria José Silva"]';

    let isLoginFlow = false;
    let isVerifyFlow = false; // 直接进入验证码步骤的登录流程

    try {
      // 同时检测登录页面、验证页面和注册页面的元素
      const loginHeading = page.locator(loginHeadingSelector).first();
      const verifyHeading = page.locator(verifyHeadingSelector).first();
      const verifyCodeInput = page.locator(verifyCodeInputSelector).first();
      const nameInput = page.locator(nameInputSelector).first();

      // 等待其中一个元素出现
      const result = await Promise.race([
        loginHeading
          .waitFor({ state: "visible", timeout: 10000 })
          .then(() => "login"),
        verifyHeading
          .waitFor({ state: "visible", timeout: 10000 })
          .then(() => "verify"),
        verifyCodeInput
          .waitFor({ state: "visible", timeout: 10000 })
          .then(() => "verify-input"),
        nameInput
          .waitFor({ state: "visible", timeout: 10000 })
          .then(() => "register"),
      ]);

      if (result === "login") {
        isLoginFlow = true;
      } else if (result === "verify" || result === "verify-input") {
        isLoginFlow = true;
        isVerifyFlow = true;
      }
    } catch {
      // 如果都没找到，尝试单独检测
      try {
        await page
          .locator(loginHeadingSelector)
          .first()
          .waitFor({ state: "visible", timeout: 3000 });
        isLoginFlow = true;
      } catch {
        try {
          // 检测 verify 标题或验证码输入框
          const hasVerify = await page
            .locator(verifyHeadingSelector)
            .first()
            .isVisible()
            .catch(() => false);
          const hasVerifyInput = await page
            .locator(verifyCodeInputSelector)
            .first()
            .isVisible()
            .catch(() => false);
          if (hasVerify || hasVerifyInput) {
            isLoginFlow = true;
            isVerifyFlow = true;
          }
        } catch {
          isLoginFlow = false;
        }
      }
    }

    const progressedSelector = await waitForAnyVisibleSelector(
      page,
      [
        loginHeadingSelector,
        verifyHeadingSelector,
        verifyCodeInputSelector,
        nameInputSelector,
      ],
      2000,
    );

    if (!progressedSelector) {
      if (
        !(await waitForManualClickAndAdvance(
          page,
          [
            loginHeadingSelector,
            verifyHeadingSelector,
            verifyCodeInputSelector,
            nameInputSelector,
          ],
          log,
          "第一个继续按钮",
        ))
      ) {
        throw new Error("点击第一个继续按钮后页面未进入下一步");
      }

      const hasVerify = await page
        .locator(verifyHeadingSelector)
        .first()
        .isVisible()
        .catch(() => false);
      const hasVerifyInput = await page
        .locator(verifyCodeInputSelector)
        .first()
        .isVisible()
        .catch(() => false);
      const hasLogin = await page
        .locator(loginHeadingSelector)
        .first()
        .isVisible()
        .catch(() => false);

      if (hasVerify || hasVerifyInput) {
        isLoginFlow = true;
        isVerifyFlow = true;
      } else if (hasLogin) {
        isLoginFlow = true;
        isVerifyFlow = false;
      }
    }

    if (isLoginFlow) {
      // ========== 登录流程（邮箱已注册）==========
      if (isVerifyFlow) {
        log("\n⚠ 检测到验证页面，邮箱已注册，直接进入验证码步骤...");
      } else {
        log("\n⚠ 检测到邮箱已注册，切换到登录流程...");
      }

      // 如果不是直接验证流程，需要先输入密码
      if (!isVerifyFlow) {
        // 步骤2(登录): 输入密码
        log("\n步骤2(登录): 输入密码...");
        const loginPasswordSelector = 'input[placeholder="Enter password"]';
        if (
          !(await waitAndFill(
            page,
            loginPasswordSelector,
            password,
            log,
            "登录密码输入框",
          ))
        ) {
          throw new Error("未找到登录密码输入框");
        }

        await page.waitForTimeout(1000);

        // 点击继续按钮
        const loginContinueSelector =
          'button[data-testid="test-primary-button"]';
        if (
          !(await waitAndClickWithRetry(
            page,
            loginContinueSelector,
            log,
            "登录继续按钮",
          ))
        ) {
          throw new Error("点击登录继续按钮失败");
        }

        await page.waitForTimeout(3000);
      }

      // 步骤3(登录): 等待验证码输入框出现，获取并输入验证码
      log("\n步骤3(登录): 获取并输入验证码...");
      // 登录验证码输入框选择器（支持多种 placeholder）
      const loginCodeSelectors = [
        'input[placeholder="6-digit"]',
        'input[placeholder="6 位数"]',
        'input[placeholder*="digit"]',
        'input[placeholder*="位"]',
        'input[inputmode="numeric"][maxlength="6"]',
        'input[autocomplete="one-time-code"]',
        'input[name*="verification"][type="text"]',
        'input[id*="verification"][type="text"]',
        'input[class*="awsui_input"][type="text"]',
      ];

      const loginCodeInput = await waitForCodeInputSelector(
        page,
        loginCodeSelectors,
        log,
        "登录验证码输入框",
        12000,
      );

      if (!loginCodeInput) {
        throw new Error("未找到登录验证码输入框");
      }

      await page.waitForTimeout(1000);

      if (manualVerification) {
        if (
          !(await waitForManualVerification(
            page,
            loginCodeInput,
            log,
            "登录验证码",
          ))
        ) {
          throw new Error("等待手动输入登录验证码超时");
        }
      } else {
        // 自动获取验证码
        let loginVerificationCode: string | null = null;
        if (luckMailOrderNo && luckMailConfig) {
          loginVerificationCode = await getLuckMailCode(
            luckMailConfig.apiKey,
            luckMailOrderNo,
            log,
            120,
          );
        } else if (refreshToken && clientId) {
          loginVerificationCode = await getOutlookVerificationCode(
            refreshToken,
            clientId,
            log,
            120,
          );
        } else {
          log("缺少验证码获取方式（未配置 LuckMail 且缺少 refresh_token/client_id）");
        }

        if (!loginVerificationCode) {
          throw new Error("无法获取登录验证码");
        }

        // 输入验证码
        if (
          !(await waitAndFill(
            page,
            loginCodeInput,
            loginVerificationCode,
            log,
            "登录验证码",
          ))
        ) {
          throw new Error("输入登录验证码失败");
        }

        await page.waitForTimeout(1000);

        // 点击验证码确认按钮
        const loginVerifySelectors = [
          'button[data-testid="test-primary-button"]',
          'button[data-testid="email-verification-verify-button"]',
          'button:has-text("Continue")',
          'button:has-text("继续")',
          'button[type="submit"]',
        ];
        if (
          !(await waitAndClickWithFallback(
            page,
            loginVerifySelectors,
            log,
            "登录验证码确认按钮",
          ))
        ) {
          throw new Error("点击登录验证码确认按钮失败");
        }
      }

      await page.waitForTimeout(5000);
    } else {
      // ========== 注册流程（新账号）==========
      // 步骤2: 等待姓名输入框出现，输入姓名
      log("\n步骤2: 输入姓名...");
      if (
        !(await waitAndFill(
          page,
          nameInputSelector,
          randomName,
          log,
          "姓名输入框",
          120000,
        ))
      ) {
        throw new Error("未找到姓名输入框");
      }

      await page.waitForTimeout(1000);

      // 点击第二个继续按钮（带错误检测和自动重试）
      // 选择器: button[data-testid="signup-next-button"]
      const secondContinueSelector = 'button[data-testid="signup-next-button"]';
      if (
        !(await waitAndClickWithRetry(
          page,
          secondContinueSelector,
          log,
          "第二个继续按钮",
        ))
      ) {
        throw new Error("点击第二个继续按钮失败");
      }

      await page.waitForTimeout(3000);

      // 步骤3: 等待验证码输入框出现，获取并输入验证码
      log("\n步骤3: 获取并输入验证码...");
      const codeInputSelectors = [
        'input[placeholder="6 位数"]',
        'input[placeholder="6-digit"]',
        'input[placeholder*="digit"]',
        'input[placeholder*="位"]',
        'input[inputmode="numeric"][maxlength="6"]',
        'input[autocomplete="one-time-code"]',
        'input[name*="verification"][type="text"]',
        'input[id*="verification"][type="text"]',
        'input[class*="awsui_input"][type="text"]',
      ];

      const codeInputSelector = await waitForCodeInputSelector(
        page,
        codeInputSelectors,
        log,
        "验证码输入框",
        30000,
      );
      if (!codeInputSelector) {
        throw new Error("未找到验证码输入框");
      }

      await page.waitForTimeout(1000);

      if (manualVerification) {
        if (
          !(await waitForManualVerification(
            page,
            codeInputSelector,
            log,
            "验证码",
          ))
        ) {
          throw new Error("等待手动输入验证码超时");
        }
      } else {
        // 自动获取验证码
        let verificationCode: string | null = null;
        if (luckMailOrderNo && luckMailConfig) {
          verificationCode = await getLuckMailCode(
            luckMailConfig.apiKey,
            luckMailOrderNo,
            log,
            120,
          );
        } else if (refreshToken && clientId) {
          verificationCode = await getOutlookVerificationCode(
            refreshToken,
            clientId,
            log,
            120,
          );
        } else {
          log("缺少验证码获取方式（未配置 LuckMail 且缺少 refresh_token/client_id）");
        }

        if (!verificationCode) {
          throw new Error("无法获取验证码");
        }

        // 输入验证码
        if (
          !(await waitAndFill(
            page,
            codeInputSelector,
            verificationCode,
            log,
            "验证码",
          ))
        ) {
          throw new Error("输入验证码失败");
        }

        await page.waitForTimeout(1000);

        // 点击 Continue 按钮（带错误检测和自动重试）
        const verifyButtonSelectors = [
          'button[data-testid="email-verification-verify-button"]',
          'button[data-testid="test-primary-button"]',
          'button:has-text("Continue")',
          'button:has-text("继续")',
          'button[type="submit"]',
        ];
        if (
          !(await waitAndClickWithFallback(
            page,
            verifyButtonSelectors,
            log,
            "Continue 按钮",
          ))
        ) {
          throw new Error("点击 Continue 按钮失败");
        }
      }

      await page.waitForTimeout(3000);

      // 步骤4: 等待密码输入框出现，输入密码
      log("\n步骤4: 输入密码...");
      await pauseForReading(page, "form");
      // 选择器: input[placeholder="Enter password"]
      const passwordInputSelector = 'input[placeholder="Enter password"]';
      if (
        !(await waitAndFill(
          page,
          passwordInputSelector,
          password,
          log,
          "密码输入框",
        ))
      ) {
        throw new Error("未找到密码输入框");
      }

      await page.waitForTimeout(500);

      // 输入确认密码
      // 选择器: input[placeholder="Re-enter password"]
      const confirmPasswordSelector = 'input[placeholder="Re-enter password"]';
      if (
        !(await waitAndFill(
          page,
          confirmPasswordSelector,
          password,
          log,
          "确认密码输入框",
        ))
      ) {
        throw new Error("未找到确认密码输入框");
      }

      await page.waitForTimeout(1000);

      // 点击第三个继续按钮（带错误检测和自动重试）
      // 选择器: button[data-testid="test-primary-button"]
      const thirdContinueSelector = 'button[data-testid="test-primary-button"]';
      if (
        !(await waitAndClickWithRetry(
          page,
          thirdContinueSelector,
          log,
          "第三个继续按钮",
        ))
      ) {
        throw new Error("点击第三个继续按钮失败");
      }

      await page.waitForTimeout(5000);
    }

    // 步骤5: 获取 SSO Token（登录和注册流程共用）
    log("\n步骤5: 获取 SSO Token...");
    let ssoToken: string | null = null;
    const ssoTokenWaitSeconds = 120;

    for (let i = 0; i < ssoTokenWaitSeconds; i++) {
      const cookies = await context.cookies();
      const ssoCookie = cookies.find((c) => c.name === "x-amz-sso_authn");
      if (ssoCookie) {
        ssoToken = ssoCookie.value;
        log(`✓ 成功获取 SSO Token (x-amz-sso_authn)!`);
        break;
      }
      log(`等待 SSO Token... (${i + 1}/${ssoTokenWaitSeconds})`);
      await page.waitForTimeout(1000);
    }

    await browser.close();
    browser = null;

    if (ssoToken) {
      log("\n========== 操作成功! ==========");
      return { success: true, ssoToken, name: randomName, email: resolvedEmail };
    } else {
      throw new Error("未能获取 SSO Token，可能操作未完成");
    }
  } catch (error) {
    log(`\n✗ 注册失败: ${error}`);
    if (browser) {
      try {
        await browser.close();
      } catch {
        void 0;
      }
    }
    // LuckMail 模式下失败时取消订单（避免扣费）
    if (luckMailOrderNo && luckMailConfig) {
      await cancelLuckMailOrder(luckMailConfig.apiKey, luckMailOrderNo, log);
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
