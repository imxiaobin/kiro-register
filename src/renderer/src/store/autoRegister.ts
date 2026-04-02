import { create } from 'zustand'

export interface RegisterAccount {
  id: string
  email: string
  password: string
  refreshToken: string
  clientId: string
  status: 'pending' | 'activating' | 'registering' | 'getting_code' | 'success' | 'failed' | 'exists'
  awsName?: string
  ssoToken?: string
  error?: string
}

interface AutoRegisterState {
  // 注册账号列表
  accounts: RegisterAccount[]
  // 是否正在运行
  isRunning: boolean
  // 日志
  logs: string[]
  // 并发数
  concurrency: number
  // 是否跳过 Outlook 激活
  skipOutlookActivation: boolean
  // 是否手动输入验证码
  manualVerification: boolean
  // 是否使用无头模式运行浏览器
  headlessMode: boolean
  // 停止标志
  shouldStop: boolean
}

interface AutoRegisterActions {
  // 添加账号
  addAccounts: (accounts: RegisterAccount[]) => void
  // 删除单个账号
  removeAccount: (id: string) => void
  // 清空账号
  clearAccounts: () => void
  // 更新账号状态
  updateAccountStatus: (id: string, updates: Partial<RegisterAccount>) => void
  // 添加日志
  addLog: (message: string) => void
  // 清空日志
  clearLogs: () => void
  // 设置运行状态
  setIsRunning: (running: boolean) => void
  // 设置并发数
  setConcurrency: (concurrency: number) => void
  // 设置跳过 Outlook 激活
  setSkipOutlookActivation: (skip: boolean) => void
  // 设置手动输入验证码
  setManualVerification: (manual: boolean) => void
  // 设置无头模式
  setHeadlessMode: (headless: boolean) => void
  // 请求停止
  requestStop: () => void
  // 重置停止标志
  resetStop: () => void
  // 持久化
  saveToStorage: () => Promise<void>
  loadFromStorage: () => Promise<void>
  // 获取统计
  getStats: () => {
    total: number
    pending: number
    running: number
    success: number
    failed: number
    exists: number
  }
}

type AutoRegisterStore = AutoRegisterState & AutoRegisterActions

export const useAutoRegisterStore = create<AutoRegisterStore>()((set, get) => ({
  // 初始状态
  accounts: [],
  isRunning: false,
  logs: [],
  concurrency: 3,
  skipOutlookActivation: false,
  manualVerification: false,
  headlessMode: false,
  shouldStop: false,

  // 添加账号
  addAccounts: (newAccounts) => {
    set((state) => ({
      accounts: [...state.accounts, ...newAccounts]
    }))
    get().saveToStorage()
  },

  // 删除单个账号
  removeAccount: (id) => {
    set((state) => ({
      accounts: state.accounts.filter(acc => acc.id !== id)
    }))
    get().saveToStorage()
  },

  // 清空账号
  clearAccounts: () => {
    if (get().isRunning) return
    set({ accounts: [], logs: [] })
    get().saveToStorage()
  },

  // 更新账号状态
  updateAccountStatus: (id, updates) => {
    set((state) => ({
      accounts: state.accounts.map(acc =>
        acc.id === id ? { ...acc, ...updates } : acc
      )
    }))
    // 只在最终状态时持久化，避免频繁写盘
    const finalStatuses = ['success', 'failed', 'exists', 'pending']
    if (updates.status && finalStatuses.includes(updates.status)) {
      get().saveToStorage()
    }
  },

  // 添加日志
  addLog: (message) => {
    const timestamp = new Date().toLocaleTimeString()
    set((state) => ({
      logs: [...state.logs, `[${timestamp}] ${message}`]
    }))
  },

  // 清空日志
  clearLogs: () => {
    set({ logs: [] })
  },

  // 设置运行状态
  setIsRunning: (running) => {
    set({ isRunning: running })
  },

  // 设置并发数
  setConcurrency: (concurrency) => {
    set({ concurrency: Math.min(10, Math.max(1, concurrency)) })
  },

  // 设置跳过 Outlook 激活
  setSkipOutlookActivation: (skip) => {
    set({ skipOutlookActivation: skip })
  },

  // 设置手动输入验证码
  setManualVerification: (manual) => {
    set({ manualVerification: manual })
  },

  // 设置无头模式
  setHeadlessMode: (headless) => {
    set({ headlessMode: headless })
  },

  // 请求停止
  requestStop: () => {
    set({ shouldStop: true })
  },

  // 重置停止标志
  resetStop: () => {
    set({ shouldStop: false })
  },

  // 持久化：保存到文件
  saveToStorage: async () => {
    const { accounts, concurrency, skipOutlookActivation, manualVerification, headlessMode } = get()
    await window.api.saveAutoRegister({ accounts, concurrency, skipOutlookActivation, manualVerification, headlessMode })
  },

  // 持久化：从文件加载
  loadFromStorage: async () => {
    const data = await window.api.loadAutoRegister() as {
      accounts?: RegisterAccount[]
      concurrency?: number
      skipOutlookActivation?: boolean
      manualVerification?: boolean
      headlessMode?: boolean
    } | null
    if (data) {
      // 将正在运行中的状态重置为 pending（应用重启后不可能还在运行）
      const accounts = (data.accounts ?? []).map(acc =>
        (acc.status === 'registering' || acc.status === 'activating' || acc.status === 'getting_code')
          ? { ...acc, status: 'pending' as const }
          : acc
      )
      set({
        accounts,
        concurrency: data.concurrency ?? 3,
        skipOutlookActivation: data.skipOutlookActivation ?? false,
        manualVerification: data.manualVerification ?? false,
        headlessMode: data.headlessMode ?? false
      })
    }
  },

  // 获取统计
  getStats: () => {
    const accounts = get().accounts
    return {
      total: accounts.length,
      pending: accounts.filter(a => a.status === 'pending').length,
      running: accounts.filter(a => a.status === 'registering' || a.status === 'activating').length,
      success: accounts.filter(a => a.status === 'success').length,
      failed: accounts.filter(a => a.status === 'failed').length,
      exists: accounts.filter(a => a.status === 'exists').length
    }
  }
}))
