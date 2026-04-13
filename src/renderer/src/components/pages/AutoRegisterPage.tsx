import { useState, useCallback, useRef, useEffect } from "react";
import {
  Play,
  Square,
  Upload,
  Trash2,
  Copy,
  CheckCircle,
  XCircle,
  Clock,
  Loader2,
  Mail,
  Key,
  RefreshCw,
  AlertCircle,
  Terminal,
  Zap,
} from "lucide-react";
import { Button } from "../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Badge } from "../ui/badge";
import { useAccountsStore } from "@/store/accounts";
import {
  useAutoRegisterStore,
  type RegisterAccount,
} from "@/store/autoRegister";
import { v4 as uuidv4 } from "uuid";
import { normalizeProxyInput, type ProxyProtocol } from "@/lib/proxy";

const AUTO_STOP_CONSECUTIVE_FAILURES = 3;

export function AutoRegisterPage() {
  const [inputText, setInputText] = useState("");
  const [proxyTestStatus, setProxyTestStatus] = useState<
    "idle" | "testing" | "success" | "error"
  >("idle");
  const [proxyTestMessage, setProxyTestMessage] = useState("");
  const [registerMode, setRegisterMode] = useState<"own" | "luckmail" | "all">(
    "own",
  );
  const logsContainerRef = useRef<HTMLDivElement>(null);

  // 使用全局 store
  const {
    accounts,
    isRunning,
    logs,
    concurrency,
    registerTargetCount,
    skipOutlookActivation,
    manualVerification,
    headlessMode,
    useLuckMail,
    luckMailApiKey,
    luckMailProjectCode,
    addAccounts,
    removeAccount,
    clearAccounts,
    updateAccountStatus,
    addLog,
    clearLogs,
    setIsRunning,
    setConcurrency,
    setRegisterTargetCount,
    setSkipOutlookActivation,
    setManualVerification,
    setHeadlessMode,
    setUseLuckMail,
    setLuckMailApiKey,
    setLuckMailProjectCode,
    luckMailEmailType,
    luckMailDomain,
    luckMailSpecifiedEmail,
    setLuckMailEmailType,
    setLuckMailDomain,
    setLuckMailSpecifiedEmail,
    luckMailTaskCount,
    setLuckMailTaskCount,
    autoFetchDeviceLink,
    setAutoFetchDeviceLink,
    requestStop,
    resetStop,
    getStats,
    loadFromStorage,
  } = useAutoRegisterStore();

  const {
    addAccount,
    saveToStorage,
    proxyUrl,
    proxyProtocol,
    setProxy,
    accounts: existingAccounts,
  } = useAccountsStore();

  // 检查邮箱是否已存在
  const isEmailExists = useCallback(
    (email: string): boolean => {
      const emailLower = email.toLowerCase();
      return Array.from(existingAccounts.values()).some(
        (acc) => acc.email.toLowerCase() === emailLower,
      );
    },
    [existingAccounts],
  );

  // 挂载时从文件加载持久化数据
  useEffect(() => {
    loadFromStorage();
  }, [loadFromStorage]);

  // 监听来自主进程的实时日志
  useEffect(() => {
    const unsubscribe = window.api.onAutoRegisterLog((data) => {
      addLog(`[${data.email.split("@")[0]}] ${data.message}`);
    });
    return () => unsubscribe();
  }, [addLog]);

  // 自动滚动到日志底部
  useEffect(() => {
    const container = logsContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [logs]);

  const isLikelyClientId = (value: string): boolean => {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.trim(),
    );
  };

  const isLikelyRefreshToken = (value: string): boolean => {
    const token = value.trim();
    return (
      token.startsWith("M.") || token.startsWith("Atza|") || token.length > 80
    );
  };

  const parseAccounts = (text: string): RegisterAccount[] => {
    const lines = text.trim().split("\n");
    const parsed: RegisterAccount[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const delimiter = trimmed.includes("----") ? "----" : "|";
      const parts = trimmed.split(delimiter).map((part) => part.trim());
      if (parts.length >= 1 && parts[0].includes("@")) {
        const email = parts[0].trim();
        const password = parts[1] || "";
        let refreshToken = "";
        let clientId = "";

        if (parts[2]) {
          const third = parts[2];
          if (delimiter === "----") {
            clientId = third;
          } else {
            refreshToken = third;
          }
        }

        if (parts[3]) {
          const third = parts[2] || "";
          const fourth = parts[3];

          const thirdLooksClientId = isLikelyClientId(third);
          const fourthLooksClientId = isLikelyClientId(fourth);
          const thirdLooksRefreshToken = isLikelyRefreshToken(third);
          const fourthLooksRefreshToken = isLikelyRefreshToken(fourth);

          // 兼容两种顺序：
          // 1) 邮箱|密码|refresh_token|client_id
          // 2) 邮箱----密码----client_id----refresh_token
          if (
            (thirdLooksClientId && fourthLooksRefreshToken) ||
            (delimiter === "----" && !thirdLooksRefreshToken)
          ) {
            clientId = third;
            refreshToken = fourth;
          } else if (
            (thirdLooksRefreshToken && fourthLooksClientId) ||
            delimiter === "|"
          ) {
            refreshToken = third;
            clientId = fourth;
          } else {
            // 无法判断时按分隔符默认顺序
            if (delimiter === "----") {
              clientId = third;
              refreshToken = fourth;
            } else {
              refreshToken = third;
              clientId = fourth;
            }
          }
        }

        // 检查是否已存在
        const exists = isEmailExists(email);
        parsed.push({
          id: uuidv4(),
          email,
          password,
          refreshToken,
          clientId,
          status: exists ? "exists" : "pending",
        });
      }
    }

    return parsed;
  };

  const handleImport = () => {
    const parsed = parseAccounts(inputText);
    if (parsed.length === 0) {
      alert("没有找到有效的邮箱账号");
      return;
    }
    const existsCount = parsed.filter((a) => a.status === "exists").length;
    addAccounts(parsed);
    setInputText("");
    addLog(
      `导入了 ${parsed.length} 个邮箱账号${existsCount > 0 ? `，其中 ${existsCount} 个已存在` : ""}`,
    );
  };

  const handleImportFile = async () => {
    try {
      const result = await window.api.openFile({
        filters: [{ name: "文本文件", extensions: ["txt"] }],
      });

      if (result && "content" in result) {
        const parsed = parseAccounts(result.content);
        if (parsed.length > 0) {
          const existsCount = parsed.filter(
            (a) => a.status === "exists",
          ).length;
          addAccounts(parsed);
          addLog(
            `从文件导入了 ${parsed.length} 个邮箱账号${existsCount > 0 ? `，其中 ${existsCount} 个已存在` : ""}`,
          );
        }
      }
    } catch (error) {
      addLog(`导入文件失败: ${error}`);
    }
  };

  const handleClear = () => {
    if (isRunning) {
      alert("请先停止注册");
      return;
    }
    clearAccounts();
  };

  // LuckMail 模式：生成占位注册任务
  const handleGenerateLuckMailTasks = () => {
    const count = useAutoRegisterStore.getState().luckMailTaskCount;
    const placeholders = Array.from({ length: count }, () => ({
      id: uuidv4(),
      email: "(LuckMail 待分配)",
      password: "",
      refreshToken: "",
      clientId: "",
      status: "pending" as const,
      isLuckMail: true,
    }));
    addAccounts(placeholders);
    addLog(`已生成 ${count} 个 LuckMail 注册任务`);
  };

  const handleTestProxyConnection = async () => {
    if (!proxyUrl.trim()) {
      alert("请输入代理地址");
      return;
    }

    setProxyTestStatus("testing");
    setProxyTestMessage("");

    try {
      const result = await window.api.testProxyConnection(
        normalizeProxyInput(proxyUrl, proxyProtocol),
      );
      if (result.success) {
        const details = [
          result.ip ? `出口 IP: ${result.ip}` : null,
          typeof result.latencyMs === "number"
            ? `耗时: ${result.latencyMs}ms`
            : null,
        ]
          .filter(Boolean)
          .join("，");
        const message = details || "代理连接成功";
        setProxyTestStatus("success");
        setProxyTestMessage(message);
        addLog(`[代理检测] ✓ ${message}`);
      } else {
        const message = result.error || "代理连接失败";
        setProxyTestStatus("error");
        setProxyTestMessage(message);
        addLog(`[代理检测] ✗ ${message}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      setProxyTestStatus("error");
      setProxyTestMessage(message);
      addLog(`[代理检测] ✗ ${message}`);
    }
  };

  // 使用 SSO Token 导入账号
  const importWithSsoToken = async (
    account: RegisterAccount,
    ssoToken: string,
    name: string,
  ) => {
    try {
      addLog(`[${account.email}] 正在通过 SSO Token 导入账号...`);

      const result = await window.api.importFromSsoToken(ssoToken, "us-east-1");

      if (result.success && result.data) {
        const { data } = result;

        // 确定 idp 类型
        const idpValue =
          (data.idp as
            | "Google"
            | "Github"
            | "BuilderId"
            | "AWSIdC"
            | "Internal") || "BuilderId";

        // 确定订阅类型
        let subscriptionType:
          | "Free"
          | "Pro"
          | "Pro_Plus"
          | "Enterprise"
          | "Teams" = "Free";
        const subType = data.subscriptionType?.toUpperCase() || "";
        if (subType.includes("PRO_PLUS") || subType.includes("PRO+")) {
          subscriptionType = "Pro_Plus";
        } else if (subType.includes("PRO")) {
          subscriptionType = "Pro";
        } else if (subType.includes("ENTERPRISE")) {
          subscriptionType = "Enterprise";
        } else if (subType.includes("TEAMS")) {
          subscriptionType = "Teams";
        }

        addAccount({
          email: data.email || account.email,
          nickname: name,
          idp: idpValue,
          credentials: {
            accessToken: data.accessToken,
            csrfToken: "",
            refreshToken: data.refreshToken,
            clientId: data.clientId,
            clientSecret: data.clientSecret,
            region: data.region || "us-east-1",
            authMethod: "IdC",
            expiresAt: Date.now() + (data.expiresIn || 3600) * 1000,
          },
          subscription: {
            type: subscriptionType,
            title: data.subscriptionTitle,
          },
          usage: data.usage
            ? {
                current: data.usage.current,
                limit: data.usage.limit,
                percentUsed:
                  data.usage.limit > 0
                    ? (data.usage.current / data.usage.limit) * 100
                    : 0,
                lastUpdated: Date.now(),
              }
            : {
                current: 0,
                limit: 50,
                percentUsed: 0,
                lastUpdated: Date.now(),
              },
          tags: [],
          status: "active",
          lastUsedAt: Date.now(),
        });

        saveToStorage();
        addLog(`[${account.email}] ✓ 已成功添加到账号管理器`);
        return true;
      } else {
        addLog(
          `[${account.email}] ✗ SSO Token 导入失败: ${result.error?.message || "未知错误"}`,
        );
        return false;
      }
    } catch (error) {
      addLog(`[${account.email}] ✗ 导入出错: ${error}`);
      return false;
    }
  };

  // 单个账号注册任务（使用全局 store 的 shouldStop）
  const registerSingleAccount = async (
    account: RegisterAccount,
  ): Promise<"success" | "failed" | "failed_nonfatal" | "skipped"> => {
    // 检查全局停止标志
    if (useAutoRegisterStore.getState().shouldStop) return "skipped";
    if (account.status === "success" || account.status === "exists")
      return "skipped";

    try {
      updateAccountStatus(account.id, { status: "registering" });
      addLog(`[${account.email}] 开始注册...`);
      const {
        skipOutlookActivation: runtimeSkipOutlookActivation,
        manualVerification: runtimeManualVerification,
        headlessMode: runtimeHeadlessMode,
        useLuckMail: runtimeUseLuckMail,
        luckMailApiKey: runtimeLuckMailApiKey,
        luckMailProjectCode: runtimeLuckMailProjectCode,
        luckMailEmailType: runtimeLuckMailEmailType,
        luckMailDomain: runtimeLuckMailDomain,
        luckMailSpecifiedEmail: runtimeLuckMailSpecifiedEmail,
        autoFetchDeviceLink: runtimeAutoFetchDeviceLink,
      } = useAutoRegisterStore.getState();

      const luckMailConfig =
        account.isLuckMail &&
        runtimeUseLuckMail &&
        runtimeLuckMailApiKey &&
        runtimeLuckMailProjectCode
          ? {
              apiKey: runtimeLuckMailApiKey,
              projectCode: runtimeLuckMailProjectCode,
              emailType: runtimeLuckMailEmailType.trim() || undefined,
              domain: runtimeLuckMailDomain.trim() || undefined,
              specifiedEmail: runtimeLuckMailSpecifiedEmail.trim() || undefined,
            }
          : undefined;

      // 调用主进程的自动注册功能
      const result = await window.api.autoRegisterAWS({
        email: account.email,
        emailPassword: account.password,
        refreshToken: account.refreshToken,
        clientId: account.clientId,
        skipOutlookActivation: runtimeSkipOutlookActivation,
        proxyUrl: proxyUrl
          ? normalizeProxyInput(proxyUrl, proxyProtocol)
          : undefined,
        manualVerification: runtimeManualVerification,
        headless: runtimeHeadlessMode && !runtimeManualVerification,
        autoFetchDeviceLink: runtimeAutoFetchDeviceLink,
        luckMailConfig,
      });

      if (result.success) {
        const actualEmail = result.email || account.email;
        updateAccountStatus(account.id, {
          status: "success",
          ...(result.ssoToken ? { ssoToken: result.ssoToken } : {}),
          awsName: result.name,
          ...(result.email ? { email: result.email } : {}),
        });
        addLog(`[${actualEmail}] ✓ 注册成功!`);

        if (result.ssoToken) {
          // 使用 SSO Token 导入账号
          await importWithSsoToken(
            { ...account, email: actualEmail },
            result.ssoToken,
            result.name || actualEmail.split("@")[0],
          );
        } else if (runtimeAutoFetchDeviceLink) {
          addLog(
            `[${actualEmail}] ℹ 自动设备授权模式未返回 SSO Token，已跳过自动导入账号管理器`,
          );
        } else {
          updateAccountStatus(account.id, {
            status: "failed",
            error: "注册成功但未获取到 SSO Token",
          });
          addLog(`[${actualEmail}] ✗ 注册成功但未获取到 SSO Token`);
          return "failed";
        }
        return "success";
      } else {
        const errorMessage = result.error || "注册失败";
        const isBannedBySigninRedirect =
          errorMessage.includes("账号可能已被封禁") ||
          errorMessage.includes("app.kiro.dev/signin");

        updateAccountStatus(account.id, {
          status: "failed",
          error: errorMessage,
        });
        addLog(`[${account.email}] ✗ 注册失败: ${errorMessage}`);
        if (isBannedBySigninRedirect) {
          addLog(`[${account.email}] ⚠ 疑似封禁账号，已跳过并继续下一个任务`);
          return "failed_nonfatal";
        }
        return "failed";
      }
    } catch (error) {
      const errorMessage = String(error);
      const isBannedBySigninRedirect =
        errorMessage.includes("账号可能已被封禁") ||
        errorMessage.includes("app.kiro.dev/signin");

      updateAccountStatus(account.id, {
        status: "failed",
        error: errorMessage,
      });
      addLog(`[${account.email}] ✗ 错误: ${errorMessage}`);
      if (isBannedBySigninRedirect) {
        addLog(`[${account.email}] ⚠ 疑似封禁账号，已跳过并继续下一个任务`);
        return "failed_nonfatal";
      }
      return "failed";
    }
  };

  const startRegistration = async () => {
    const state = useAutoRegisterStore.getState();
    const {
      useLuckMail: runtimeUseLuckMail,
      luckMailApiKey: runtimeKey,
      luckMailProjectCode: runtimeCode,
      luckMailTaskCount: taskCount,
    } = state;

    const needsLuckMail = registerMode === "luckmail" || registerMode === "all";
    const needsOwn = registerMode === "own" || registerMode === "all";

    // LuckMail 模式校验 + 自动生成占位任务
    if (needsLuckMail) {
      if (!runtimeUseLuckMail || !runtimeKey || !runtimeCode) {
        alert("请先在 LuckMail 配置中启用并填写 API Key 和项目代码");
        return;
      }
      const pendingLuckMail = state.accounts.filter(
        (a) =>
          (a.status === "pending" || a.status === "failed") && a.isLuckMail,
      );
      if (pendingLuckMail.length === 0) {
        const placeholders = Array.from({ length: taskCount }, () => ({
          id: uuidv4(),
          email: "(LuckMail 待分配)",
          password: "",
          refreshToken: "",
          clientId: "",
          status: "pending" as const,
          isLuckMail: true,
        }));
        addAccounts(placeholders);
        addLog(`[LuckMail] 自动生成 ${taskCount} 个注册任务`);
      }
    }

    // 根据模式过滤并限制数量
    const allAccounts = useAutoRegisterStore.getState().accounts;
    let targetAccounts: RegisterAccount[] = [];
    if (needsOwn) {
      const ownPending = allAccounts.filter(
        (a) =>
          !a.isLuckMail && (a.status === "pending" || a.status === "failed"),
      );
      targetAccounts = [
        ...targetAccounts,
        ...ownPending.slice(0, registerTargetCount),
      ];
    }
    if (needsLuckMail) {
      const luckPending = allAccounts.filter(
        (a) =>
          a.isLuckMail && (a.status === "pending" || a.status === "failed"),
      );
      targetAccounts = [...targetAccounts, ...luckPending.slice(0, taskCount)];
    }

    if (targetAccounts.length === 0) {
      alert("没有需要注册的账号（已存在或已成功的账号会被跳过）");
      return;
    }

    const skippedFinishedCount =
      allAccounts.length -
      allAccounts.filter((a) => a.status === "pending" || a.status === "failed")
        .length;
    const deferredCount = 0;

    setIsRunning(true);
    resetStop();
    addLog(`========== 开始批量注册 (并发数: ${concurrency}) ==========`);
    addLog(
      `本次目标注册: ${registerTargetCount} 个，实际执行: ${targetAccounts.length} 个，已完成/已存在: ${skippedFinishedCount} 个`,
    );
    if (deferredCount > 0) {
      addLog(`剩余待注册但本次未执行: ${deferredCount} 个`);
    }
    addLog(
      `浏览器模式: ${manualVerification ? "有头（手动验证码）" : headlessMode ? "无头" : "有头"}`,
    );
    if (manualVerification) {
      addLog(
        "当前为手动验证码模式，请在浏览器窗口中自行输入验证码并点击 Continue",
      );
      if (concurrency > 1) {
        addLog("⚠ 手动验证码模式下建议将并发数设为 1");
      }
    }
    if (autoFetchDeviceLink) {
      addLog("登录成功后将自动获取设备码链接并等待你手动授权完成");
    }

    // 并发执行注册任务
    const runConcurrent = async () => {
      const queue = [...targetAccounts];
      const running: Promise<void>[] = [];
      let consecutiveFailures = 0;

      while (queue.length > 0 || running.length > 0) {
        // 检查全局停止标志
        if (useAutoRegisterStore.getState().shouldStop) {
          addLog("用户停止了注册");
          break;
        }

        // 填充到并发数
        while (queue.length > 0 && running.length < concurrency) {
          const account = queue.shift()!;
          const task = registerSingleAccount(account).then((result) => {
            if (result === "success") {
              consecutiveFailures = 0;
            } else if (result === "failed") {
              consecutiveFailures += 1;
              if (
                consecutiveFailures >= AUTO_STOP_CONSECUTIVE_FAILURES &&
                !useAutoRegisterStore.getState().shouldStop
              ) {
                requestStop();
                addLog(
                  `⚠ 连续失败 ${AUTO_STOP_CONSECUTIVE_FAILURES} 个，已自动停止注册`,
                );
              }
            } else if (result === "failed_nonfatal") {
              consecutiveFailures = 0;
            }
            // 任务完成后从 running 中移除
            const index = running.indexOf(task);
            if (index > -1) running.splice(index, 1);
          });
          running.push(task);
        }

        // 等待任意一个任务完成
        if (running.length > 0) {
          await Promise.race(running);
        }
      }
    };

    await runConcurrent();

    setIsRunning(false);
    const stats = getStats();
    addLog(
      `========== 注册完成: 成功 ${stats.success}，失败 ${stats.failed} ==========`,
    );
  };

  const stopRegistration = () => {
    requestStop();
    addLog("正在停止注册...");
  };

  const copyToken = (token: string) => {
    navigator.clipboard.writeText(token);
  };

  const getStatusBadge = (status: RegisterAccount["status"]) => {
    switch (status) {
      case "pending":
        return (
          <Badge variant="secondary">
            <Clock className="w-3 h-3 mr-1" />
            等待
          </Badge>
        );
      case "exists":
        return (
          <Badge
            variant="outline"
            className="text-orange-500 border-orange-500"
          >
            <AlertCircle className="w-3 h-3 mr-1" />
            已存在
          </Badge>
        );
      case "activating":
        return (
          <Badge variant="default" className="bg-purple-500">
            <Zap className="w-3 h-3 mr-1 animate-pulse" />
            激活中
          </Badge>
        );
      case "registering":
        return (
          <Badge variant="default">
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
            注册中
          </Badge>
        );
      case "getting_code":
        return (
          <Badge variant="default">
            <Mail className="w-3 h-3 mr-1" />
            获取验证码
          </Badge>
        );
      case "success":
        return (
          <Badge variant="default" className="bg-green-500">
            <CheckCircle className="w-3 h-3 mr-1" />
            成功
          </Badge>
        );
      case "failed":
        return (
          <Badge variant="destructive">
            <XCircle className="w-3 h-3 mr-1" />
            失败
          </Badge>
        );
    }
  };

  // 单个 Outlook 激活任务
  const activateSingleOutlook = async (
    account: RegisterAccount,
  ): Promise<void> => {
    if (useAutoRegisterStore.getState().shouldStop) return;

    try {
      updateAccountStatus(account.id, { status: "activating" });
      addLog(`[${account.email}] 开始激活 Outlook...`);

      const result = await window.api.activateOutlook({
        email: account.email,
        emailPassword: account.password,
        headless: useAutoRegisterStore.getState().headlessMode,
      });

      if (result.success) {
        updateAccountStatus(account.id, { status: "pending" });
        addLog(`[${account.email}] ✓ Outlook 激活成功!`);
      } else {
        addLog(`[${account.email}] ⚠ Outlook 激活可能未完成: ${result.error}`);
      }
    } catch (error) {
      addLog(`[${account.email}] ✗ 激活错误: ${error}`);
    }
  };

  // 仅激活 Outlook 邮箱（支持并发）
  const activateOutlookOnly = async () => {
    const outlookAccounts = accounts.filter(
      (a) =>
        a.email.toLowerCase().includes("outlook") &&
        a.password &&
        a.status !== "exists" &&
        a.status !== "success",
    );

    if (outlookAccounts.length === 0) {
      alert("没有找到需要激活的 Outlook 邮箱账号");
      return;
    }

    setIsRunning(true);
    resetStop();
    addLog(
      `========== 开始批量激活 Outlook (并发数: ${concurrency}) ==========`,
    );

    // 并发执行激活任务
    const runConcurrent = async () => {
      const queue = [...outlookAccounts];
      const running: Promise<void>[] = [];

      while (queue.length > 0 || running.length > 0) {
        if (useAutoRegisterStore.getState().shouldStop) {
          addLog("用户停止了激活");
          break;
        }

        while (queue.length > 0 && running.length < concurrency) {
          const account = queue.shift()!;
          const task = activateSingleOutlook(account).then(() => {
            const index = running.indexOf(task);
            if (index > -1) running.splice(index, 1);
          });
          running.push(task);
        }

        if (running.length > 0) {
          await Promise.race(running);
        }
      }
    };

    await runConcurrent();

    setIsRunning(false);
    addLog("========== Outlook 激活流程完成 ==========");
  };

  const stats = getStats();
  const ownAccounts = accounts.filter((a) => !a.isLuckMail);
  const luckMailAccounts = accounts.filter((a) => a.isLuckMail);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">AWS 自动注册</h1>
          <p className="text-muted-foreground">
            自动注册 AWS Builder ID 并添加到账号管理器
          </p>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <div className="flex flex-col gap-1">
            <div className="flex gap-2 items-center">
              <select
                value={proxyProtocol}
                onChange={(e) => {
                  setProxy(true, proxyUrl, e.target.value as ProxyProtocol);
                  setProxyTestStatus("idle");
                  setProxyTestMessage("");
                }}
                disabled={isRunning}
                className="px-3 py-1.5 border rounded-lg bg-background text-sm"
              >
                <option value="http">HTTP(S)</option>
                <option value="socks5">SOCKS5</option>
              </select>
              <input
                type="text"
                placeholder={
                  proxyProtocol === "http"
                    ? "代理地址 (如 http://user:pass@127.0.0.1:7890)"
                    : "代理地址 (如 socks5://user:pass@127.0.0.1:1080)"
                }
                value={proxyUrl}
                onChange={(e) => {
                  setProxy(true, e.target.value, proxyProtocol);
                  setProxyTestStatus("idle");
                  setProxyTestMessage("");
                }}
                disabled={isRunning}
                className="px-3 py-1.5 border rounded-lg bg-background text-sm w-56"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleTestProxyConnection}
                disabled={
                  isRunning || !proxyUrl.trim() || proxyTestStatus === "testing"
                }
              >
                {proxyTestStatus === "testing" ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  "检测代理"
                )}
              </Button>
            </div>
            {proxyTestStatus !== "idle" && (
              <div
                className={`flex items-center gap-1 text-xs ${proxyTestStatus === "success" ? "text-green-600" : proxyTestStatus === "error" ? "text-red-600" : "text-muted-foreground"}`}
              >
                {proxyTestStatus === "success" && (
                  <CheckCircle className="w-3.5 h-3.5" />
                )}
                {proxyTestStatus === "error" && (
                  <XCircle className="w-3.5 h-3.5" />
                )}
                {proxyTestStatus === "testing" && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                )}
                <span>{proxyTestMessage || "正在检测代理..."}</span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-1">
            <span className="text-sm text-muted-foreground">并发:</span>
            <select
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.target.value))}
              disabled={isRunning}
              className="px-2 py-1.5 border rounded-lg bg-background text-sm w-16"
            >
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-sm text-muted-foreground">总数:</span>
            <input
              type="number"
              min={1}
              step={1}
              value={registerTargetCount}
              onChange={(e) => setRegisterTargetCount(Number(e.target.value))}
              disabled={isRunning}
              className="px-2 py-1.5 border rounded-lg bg-background text-sm w-20"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={skipOutlookActivation}
              onChange={(e) => setSkipOutlookActivation(e.target.checked)}
              disabled={isRunning}
              className="rounded"
            />
            跳过激活
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={manualVerification}
              onChange={(e) => {
                const nextManualVerification = e.target.checked;
                setManualVerification(nextManualVerification);
                if (nextManualVerification && headlessMode) {
                  setHeadlessMode(false);
                  addLog("⚠ 手动验证码模式已开启，已自动关闭无头模式");
                }
              }}
              disabled={isRunning}
              className="rounded"
            />
            手动验证码
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={headlessMode}
              onChange={(e) => setHeadlessMode(e.target.checked)}
              disabled={isRunning || manualVerification}
              className="rounded"
            />
            无头模式
          </label>
          <Button
            variant="outline"
            onClick={activateOutlookOnly}
            disabled={isRunning || accounts.length === 0}
          >
            <Zap className="w-4 h-4 mr-2" />
            激活 Outlook
          </Button>
          <div className="flex items-center gap-1">
            <span className="text-sm text-muted-foreground">模式:</span>
            <select
              value={registerMode}
              onChange={(e) =>
                setRegisterMode(e.target.value as "own" | "luckmail" | "all")
              }
              disabled={isRunning}
              className="px-2 py-1.5 border rounded-lg bg-background text-sm"
            >
              <option value="own">自有邮箱</option>
              <option value="luckmail">LuckMail</option>
              <option value="all">两者</option>
            </select>
          </div>
          {isRunning ? (
            <Button variant="destructive" onClick={stopRegistration}>
              <Square className="w-4 h-4 mr-2" />
              停止
            </Button>
          ) : (
            <Button
              onClick={startRegistration}
              disabled={
                (registerMode === "own" && ownAccounts.length === 0) ||
                (registerMode === "luckmail" && !useLuckMail) ||
                (registerMode === "all" &&
                  ownAccounts.length === 0 &&
                  !useLuckMail)
              }
            >
              <Play className="w-4 h-4 mr-2" />
              开始注册
            </Button>
          )}
        </div>
      </div>

      {/* 统计信息 */}
      {accounts.length > 0 && (
        <div className="grid grid-cols-6 gap-4">
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold">{stats.total}</div>
              <div className="text-sm text-muted-foreground">总数</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold text-yellow-500">
                {stats.pending}
              </div>
              <div className="text-sm text-muted-foreground">等待中</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold text-blue-500">
                {stats.running}
              </div>
              <div className="text-sm text-muted-foreground">进行中</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold text-green-500">
                {stats.success}
              </div>
              <div className="text-sm text-muted-foreground">成功</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold text-red-500">
                {stats.failed}
              </div>
              <div className="text-sm text-muted-foreground">失败</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold text-orange-500">
                {stats.exists}
              </div>
              <div className="text-sm text-muted-foreground">已存在</div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* LuckMail 配置 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="w-5 h-5" />
            LuckMail 接入（Mode A：按单收码，平台分配邮箱）
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={useLuckMail}
              onChange={(e) => setUseLuckMail(e.target.checked)}
              disabled={isRunning}
              className="rounded"
            />
            启用 LuckMail 自动收码（启用后无需手动提供邮箱，由平台分配）
          </label>
          {useLuckMail && (
            <div className="flex flex-wrap gap-3 items-end">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">API Key</span>
                <input
                  type="password"
                  placeholder="输入 LuckMail API Key"
                  value={luckMailApiKey}
                  onChange={(e) => setLuckMailApiKey(e.target.value)}
                  disabled={isRunning}
                  className="px-3 py-1.5 border rounded-lg bg-background text-sm w-64 font-mono"
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">项目代码</span>
                <input
                  type="text"
                  placeholder="如 kiro_aws"
                  value={luckMailProjectCode}
                  onChange={(e) => setLuckMailProjectCode(e.target.value)}
                  disabled={isRunning}
                  className="px-3 py-1.5 border rounded-lg bg-background text-sm w-40"
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">任务数量</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={luckMailTaskCount}
                  onChange={(e) => setLuckMailTaskCount(Number(e.target.value))}
                  disabled={isRunning}
                  className="px-2 py-1.5 border rounded-lg bg-background text-sm w-20"
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  邮箱类型（可选）
                </span>
                <input
                  type="text"
                  placeholder="如 ms_graph"
                  value={luckMailEmailType}
                  onChange={(e) => setLuckMailEmailType(e.target.value)}
                  disabled={isRunning}
                  className="px-2 py-1.5 border rounded-lg bg-background text-sm w-32"
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  域名（可选）
                </span>
                <input
                  type="text"
                  placeholder="如 outlook.com"
                  value={luckMailDomain}
                  onChange={(e) => setLuckMailDomain(e.target.value)}
                  disabled={isRunning}
                  className="px-3 py-1.5 border rounded-lg bg-background text-sm w-40"
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  指定邮箱（可选）
                </span>
                <input
                  type="text"
                  placeholder="如 test@example.com"
                  value={luckMailSpecifiedEmail}
                  onChange={(e) => setLuckMailSpecifiedEmail(e.target.value)}
                  disabled={isRunning}
                  className="px-3 py-1.5 border rounded-lg bg-background text-sm w-56"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleGenerateLuckMailTasks}
                disabled={isRunning}
              >
                生成 {luckMailTaskCount} 个注册任务
              </Button>
              <p className="text-xs text-muted-foreground w-full">
                点击"开始注册"时若任务列表为空，将自动按上方总数生成占位任务；注册成功后邮箱将更新为平台实际分配的地址。
              </p>
              <div className="flex flex-col gap-1 w-full">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={autoFetchDeviceLink}
                    onChange={(e) => setAutoFetchDeviceLink(e.target.checked)}
                    disabled={isRunning}
                    className="rounded"
                  />
                  登录成功后自动获取设备码链接并等待手动授权
                </label>
                <p className="text-xs text-muted-foreground">
                  开启后，无需手填设备链接；程序会自动调用接口获取链接并打开，等待你完成授权。
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-6">
        {/* 左侧：输入区域 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="w-5 h-5" />
              邮箱账号
            </CardTitle>
            <CardDescription>
              格式1: 邮箱|密码|refresh_token|client_id；格式2:
              邮箱----密码----client_id----refresh_token
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <textarea
              className="w-full h-32 p-3 border rounded-lg bg-background resize-none font-mono text-sm"
              placeholder={
                manualVerification
                  ? "example@outlook.com|password\nexample@outlook.com----password"
                  : "example@outlook.com|password|M.C509_xxx...|9e5f94bc-xxx...\nexample@outlook.com----password----9e5f94bc-xxx----M.C509_xxx..."
              }
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              disabled={isRunning}
            />
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={handleImport}
                disabled={isRunning || !inputText}
              >
                <RefreshCw className="w-4 h-4 mr-2" />
                解析添加
              </Button>
              <Button
                variant="outline"
                onClick={handleImportFile}
                disabled={isRunning}
              >
                <Upload className="w-4 h-4 mr-2" />
                从文件导入
              </Button>
              <Button
                variant="outline"
                onClick={handleClear}
                disabled={isRunning}
              >
                <Trash2 className="w-4 h-4 mr-2" />
                清空
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* 右侧：日志 */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="flex items-center gap-2">
              <Terminal className="w-5 h-5" />
              运行日志
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={clearLogs}>
              <Trash2 className="w-4 h-4" />
            </Button>
          </CardHeader>
          <CardContent>
            <div
              ref={logsContainerRef}
              className="h-48 overflow-auto bg-black/90 rounded-lg p-3 font-mono text-xs space-y-0.5"
            >
              {logs.length === 0 ? (
                <div className="text-gray-500">暂无日志</div>
              ) : (
                logs.map((log, i) => (
                  <div
                    key={i}
                    className={
                      log.includes("✓")
                        ? "text-green-400"
                        : log.includes("✗") ||
                            log.includes("错误") ||
                            log.includes("失败")
                          ? "text-red-400"
                          : log.includes("=====")
                            ? "text-yellow-400"
                            : log.includes("[stderr]")
                              ? "text-orange-400"
                              : "text-gray-300"
                    }
                  >
                    {log}
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* LuckMail 任务列表 */}
      {luckMailAccounts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Key className="w-5 h-5" />
              LuckMail 注册任务列表
              <Badge variant="secondary">{luckMailAccounts.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-4 py-2 text-left text-sm font-medium">
                      序号
                    </th>
                    <th className="px-4 py-2 text-left text-sm font-medium">
                      邮箱（注册后更新）
                    </th>
                    <th className="px-4 py-2 text-left text-sm font-medium">
                      姓名
                    </th>
                    <th className="px-4 py-2 text-left text-sm font-medium">
                      状态
                    </th>
                    <th className="px-4 py-2 text-left text-sm font-medium">
                      Token
                    </th>
                    <th className="px-4 py-2 text-left text-sm font-medium">
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {luckMailAccounts.map((account, index) => (
                    <tr key={account.id} className="border-t">
                      <td className="px-4 py-2 text-sm">{index + 1}</td>
                      <td className="px-4 py-2 text-sm font-mono">
                        {account.email}
                      </td>
                      <td className="px-4 py-2 text-sm">
                        {account.awsName || "-"}
                      </td>
                      <td className="px-4 py-2">
                        {getStatusBadge(account.status)}
                      </td>
                      <td className="px-4 py-2 text-sm font-mono">
                        {account.ssoToken
                          ? account.ssoToken.substring(0, 20) + "..."
                          : "-"}
                      </td>
                      <td className="px-4 py-2 flex items-center gap-1">
                        {account.ssoToken && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => copyToken(account.ssoToken!)}
                          >
                            <Copy className="w-4 h-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeAccount(account.id)}
                          disabled={
                            account.status === "registering" ||
                            account.status === "activating"
                          }
                          className="text-red-500 hover:text-red-600 hover:bg-red-50"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 自有邮箱列表 */}
      {ownAccounts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="w-5 h-5" />
              自有邮箱注册列表
              <Badge variant="secondary">{ownAccounts.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-4 py-2 text-left text-sm font-medium">
                      序号
                    </th>
                    <th className="px-4 py-2 text-left text-sm font-medium">
                      邮箱
                    </th>
                    <th className="px-4 py-2 text-left text-sm font-medium">
                      姓名
                    </th>
                    <th className="px-4 py-2 text-left text-sm font-medium">
                      状态
                    </th>
                    <th className="px-4 py-2 text-left text-sm font-medium">
                      Token
                    </th>
                    <th className="px-4 py-2 text-left text-sm font-medium">
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {ownAccounts.map((account, index) => (
                    <tr key={account.id} className="border-t">
                      <td className="px-4 py-2 text-sm">{index + 1}</td>
                      <td className="px-4 py-2 text-sm font-mono">
                        {account.email}
                      </td>
                      <td className="px-4 py-2 text-sm">
                        {account.awsName || "-"}
                      </td>
                      <td className="px-4 py-2">
                        {getStatusBadge(account.status)}
                      </td>
                      <td className="px-4 py-2 text-sm font-mono">
                        {account.ssoToken
                          ? account.ssoToken.substring(0, 20) + "..."
                          : "-"}
                      </td>
                      <td className="px-4 py-2 flex items-center gap-1">
                        {account.ssoToken && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => copyToken(account.ssoToken!)}
                          >
                            <Copy className="w-4 h-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeAccount(account.id)}
                          disabled={
                            account.status === "registering" ||
                            account.status === "activating"
                          }
                          className="text-red-500 hover:text-red-600 hover:bg-red-50"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 使用说明 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5" />
            使用说明
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>1. 输入邮箱账号信息，支持两种格式：</p>
          <p className="pl-4 text-xs">
            -{" "}
            <code className="bg-muted px-1 rounded">
              邮箱|密码|refresh_token|client_id
            </code>
            <br />-{" "}
            <code className="bg-muted px-1 rounded">
              邮箱----密码----client_id----refresh_token
            </code>
            <br />
            - 密码: 邮箱密码（用于 Outlook 激活）
            <br />
            - refresh_token: OAuth2 刷新令牌 (M.C509_xxx...)
            <br />- client_id: Graph API 客户端ID (9e5f94bc-xxx...)
          </p>
          <p className="pl-4 text-xs">
            - 勾选"手动验证码"后，可只填写{" "}
            <code className="bg-muted px-1 rounded">邮箱|密码</code> 或{" "}
            <code className="bg-muted px-1 rounded">邮箱----密码</code>
            <br />- 到验证码页面时，程序会等待你在浏览器窗口中手动输入并提交
          </p>
          <p>
            2. <strong>账号重复检测</strong>:
            导入时自动检测已存在的账号，显示"已存在"状态并跳过注册
          </p>
          <p>
            3. <strong>批量并发</strong>:
            支持同时打开多个浏览器窗口进行注册，最多 10 个并发
          </p>
          <p>
            4. <strong>Outlook 激活</strong>: 新注册的 Outlook
            邮箱需要先激活才能正常接收验证码
          </p>
          <p className="pl-4 text-xs">
            - 点击"激活 Outlook"可以批量激活邮箱
            <br />- 勾选"跳过激活"可以跳过激活步骤（适合已激活的邮箱）
          </p>
          <p>
            5. <strong>代理设置</strong>: 输入代理地址用于 AWS 注册（Outlook
            激活和获取验证码不使用代理）
          </p>
          <p>6. 点击"开始注册"，程序会并发完成 AWS Builder ID 注册</p>
          <p>
            7. <strong>无头模式</strong>:
            勾选后浏览器窗口不显示；与"手动验证码"互斥，手动模式会自动关闭无头
          </p>
          <p>8. 已移除拟人化模式，流程固定为标准自动化操作</p>
          <p className="text-yellow-500 flex items-center gap-1">
            <AlertCircle className="w-4 h-4" />
            首次使用需要安装浏览器: 在终端运行{" "}
            <code className="bg-muted px-1 rounded">
              npx playwright install chromium
            </code>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
