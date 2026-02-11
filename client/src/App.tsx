import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  ColorInput,
  Checkbox,
  Divider,
  Group,
  Modal,
  NumberInput,
  SegmentedControl,
  Select as MantineSelect,
  Slider,
  Stack,
  Switch,
  Textarea,
  Text,
  TextInput,
  Title,
  Tooltip,
  UnstyledButton
} from "@mantine/core";
import { applyVisibilityGuard, apcaEstimate } from "./contrast";
import { TaskText, FitConfig, FitMetrics } from "./textFit";

type Mode = "learning" | "contest";
type ContestType = "time" | "tasks";
type ContentMode = "default" | "vocab";

type Task = {
  id: string;
  level: number;
  answer: string;
  prompt: string;
  sentence?: string;
  wordIndex?: number;
  words?: string[];
};

type LeaderboardEntry = {
  id: number;
  playerName: string;
  createdAt: string;
  contestType: ContestType;
  level: number;
  contentMode: ContentMode;
  duration: number | null;
  taskTarget: number | null;
  score: number;
  accuracy: number;
  cpm: number;
  mistakes: number;
  tasksCompleted: number;
  timeSeconds: number;
  maxStreak: number;
};

type VocabPack = {
  id: number;
  name: string;
  packType: "level2" | "level3" | "sentence_words";
  items: string[];
  active: number;
  createdAt: string;
};

type DbAdminConfig = {
  sqlitePath: string;
  postgres: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    connectionString?: string;
  };
};

type DbAdminStatus = {
  activeDriver: "sqlite" | "postgres";
  maintenanceMode: boolean;
  counts?: {
    settings: number;
    leaderboard: number;
    vocab_packs: number;
  };
  dbConfig?: DbAdminConfig;
  runtime?: any;
};

type CrashEvent = {
  id: number;
  occurredAt: string;
  appVersion?: string;
  appBuild?: string;
  appCommit?: string;
  appMode?: string;
  crashType: string;
  startupPhase?: string;
  errorName?: string;
  errorMessage?: string;
  stackTrace?: string;
  resolved?: number;
  acknowledgedAt?: string | null;
  acknowledgedBy?: string | null;
  metadataJson?: any;
};

type ConfigState = "READY" | "MISSING" | "INVALID";
type ConfigOverall = "READY" | "SETUP_REQUIRED" | "DEGRADED" | "MAINTENANCE";
type ConfigStatusDetail = {
  key: string;
  severity: "INFO" | "WARN" | "ERROR";
  message: string;
  remediation_hint: string;
  affected_features: string[];
  blocking: boolean;
};
type ConfigStatus = {
  overall: ConfigOverall;
  required: {
    database: ConfigState;
    adminUser: ConfigState;
  };
  optional: {
    smtp: ConfigState;
    googleAuth: ConfigState;
    openai: ConfigState;
    languagePacks: ConfigState;
  };
  details: ConfigStatusDetail[];
  computed_at: string;
  config_version: number;
};

type ClientErrorTrace = {
  at: string;
  action: string;
  message: string;
  status?: number;
  code?: string;
  requestId?: string;
  url?: string;
  stack?: string;
  details?: any;
};

type Screen = "home" | "game" | "results" | "leaderboard" | "settings" | "about";

type GameSettings = {
  mode: Mode;
  level: number;
  contestType: ContestType;
  duration: 30 | 60 | 120;
  taskTarget: 10 | 20 | 50;
  contentMode: ContentMode;
  language: string;
  playerName: string;
};

type GameStats = {
  correct: number;
  incorrect: number;
  tasksCompleted: number;
  streak: number;
  maxStreak: number;
};

type TextSize = "small" | "medium" | "large" | "xlarge";
type ThemeName = "high_contrast" | "soft_pastel" | "dark_calm" | "warm_playful" | "custom";
type VisualSet = "stars" | "hearts" | "balloons" | "smiles" | "confetti";
type SoundName = "chime" | "pop" | "bell" | "sparkle" | "off";
type Intensity = "very_low" | "low" | "medium" | "high";
type Variation = "same" | "small" | "high";

type AppSettings = {
  version: number;
  textSize: TextSize;
  autoFitText: boolean;
  theme: ThemeName;
  lowStimulation: boolean;
  visibilityGuard: "off" | "aa" | "aaa";
  customTheme: {
    background: string;
    backgroundAlt: string;
    panel: string;
    text: string;
    mutedText: string;
    accent: string;
    highlight: string;
    correct: string;
    mistake: string;
  };
  flatTheme: boolean;
  correctEffects: {
    visualSet: VisualSet;
    randomizeVisual: boolean;
    animated: boolean;
    transformLetter: boolean;
    durationMs: number;
    sound: SoundName;
    randomizeSound: boolean;
    volume: number;
    intensity: Intensity;
    variation: Variation;
  };
  soundEnabled: boolean;
  agePreset: string;
  allowedLevels: number[];
  animationSpeed: number;
  mistakeStyle: "gentle" | "normal";
  stagePadding: "small" | "medium" | "large";
  languageReminder: boolean;
  perCharProgress: boolean;
  wrongCharBehavior: "block" | "retry" | "skip";
  streakPolicy: "first_wrong" | "task_fail" | "never";
  rollingCart: "off" | "on";
  rollingIntensity: "minimal" | "normal";
  spaceRequired: boolean;
  debugLayout: boolean;
  showBounds: boolean;
  apcaDeveloper: boolean;
  warnOnExitContest: boolean;
  maxAllowedLevel: number;
  differentiateZero: boolean;
  zeroStyle: "dot" | "slashed" | "dotted";
  protectFunctionKeys: boolean;
};

type PublicVersion = {
  version: string;
  build: string;
  commit: string;
  buildTime?: string | null;
  githubUrl?: string;
  website?: string;
  contact?: string;
  appMode?: string;
};

const SOUND_PREF_KEY = "ktrain_sound_enabled";

const defaultSettings: GameSettings = {
  mode: "learning",
  level: 1,
  contestType: "time",
  duration: 60,
  taskTarget: 20,
  contentMode: "default",
  language: "en",
  playerName: ""
};

const defaultAppSettings: AppSettings = {
  version: 2,
  textSize: "large",
  autoFitText: true,
  theme: "warm_playful",
  lowStimulation: false,
  visibilityGuard: "aaa",
  customTheme: {
    background: "#0e0f1b",
    backgroundAlt: "#232842",
    panel: "#1f2235",
    text: "#f5f2e9",
    mutedText: "#c7c1b6",
    accent: "#ffb703",
    highlight: "#ffd166",
    correct: "#06d6a0",
    mistake: "#f4a261"
  },
  flatTheme: false,
  correctEffects: {
    visualSet: "stars",
    randomizeVisual: true,
    animated: true,
    transformLetter: true,
    durationMs: 650,
    sound: "chime",
    randomizeSound: false,
    volume: 0.45,
    intensity: "medium",
    variation: "small"
  },
  soundEnabled: true,
  agePreset: "custom",
  allowedLevels: [1, 2, 3, 4, 5],
  animationSpeed: 1,
  mistakeStyle: "gentle",
  stagePadding: "medium",
  languageReminder: true,
  perCharProgress: true,
  wrongCharBehavior: "block",
  streakPolicy: "task_fail",
  rollingCart: "off",
  rollingIntensity: "minimal",
  spaceRequired: false,
  debugLayout: false,
  showBounds: false,
  apcaDeveloper: false,
  warnOnExitContest: true,
  maxAllowedLevel: 5,
  differentiateZero: true,
  zeroStyle: "dot",
  protectFunctionKeys: true
};

const buildAllowedLevels = (maxLevel: number) => Array.from({ length: Math.max(1, Math.min(5, maxLevel)) }, (_, i) => i + 1);

const deriveMaxAllowed = (levels?: number[]) => {
  if (!Array.isArray(levels) || levels.length === 0) return 5;
  const sorted = Array.from(new Set(levels.map((n) => Number(n)).filter((n) => n >= 1 && n <= 5))).sort((a, b) => a - b);
  let max = 0;
  for (const lvl of sorted) {
    if (lvl === max + 1) max = lvl;
    else break;
  }
  return max || 1;
};

const themePresets: Record<ThemeName, AppSettings["customTheme"]> = {
  high_contrast: {
    background: "#000000",
    backgroundAlt: "#1a1a1a",
    panel: "#111111",
    text: "#ffffff",
    mutedText: "#dcdcdc",
    accent: "#ffd166",
    highlight: "#ffd166",
    correct: "#2ecc71",
    mistake: "#f4a261"
  },
  soft_pastel: {
    background: "#f7f4ff",
    backgroundAlt: "#e8e1ff",
    panel: "#ffffff",
    text: "#2d2a3a",
    mutedText: "#6f6a7b",
    accent: "#cdb4ff",
    highlight: "#cdb4ff",
    correct: "#bde0fe",
    mistake: "#ffc8dd"
  },
  dark_calm: {
    background: "#0b1d2a",
    backgroundAlt: "#142f43",
    panel: "#102435",
    text: "#e6f0ff",
    mutedText: "#a8b6c7",
    accent: "#7db9de",
    highlight: "#7db9de",
    correct: "#5cc8a1",
    mistake: "#f2b880"
  },
  warm_playful: {
    background: "#24130a",
    backgroundAlt: "#432818",
    panel: "#2d1b12",
    text: "#fff2e6",
    mutedText: "#e2cbb7",
    accent: "#ffb703",
    highlight: "#ffb703",
    correct: "#80ed99",
    mistake: "#ff9f1c"
  },
  custom: defaultAppSettings.customTheme
};

const agePresets: Record<string, Partial<AppSettings> & { maxAllowedLevel: number }> = {
  "2-3": {
    textSize: "xlarge",
    theme: "high_contrast",
    flatTheme: true,
    lowStimulation: true,
    customTheme: {
      background: "#ffffff",
      backgroundAlt: "#ffffff",
      panel: "#ffffff",
      text: "#000000",
      mutedText: "#000000",
      accent: "#000000",
      highlight: "#00A650",
      correct: "#00A650",
      mistake: "#D0021B"
    },
    correctEffects: { intensity: "low", variation: "same", animated: false } as AppSettings["correctEffects"],
    animationSpeed: 0.7,
    maxAllowedLevel: 2,
    mistakeStyle: "gentle"
  },
  "3-4": {
    textSize: "xlarge",
    theme: "warm_playful",
    correctEffects: { intensity: "low", variation: "small" } as AppSettings["correctEffects"],
    animationSpeed: 0.9,
    maxAllowedLevel: 3,
    mistakeStyle: "gentle"
  },
  "4-5": {
    textSize: "large",
    theme: "warm_playful",
    correctEffects: { intensity: "medium", variation: "small" } as AppSettings["correctEffects"],
    animationSpeed: 1,
    maxAllowedLevel: 4,
    mistakeStyle: "gentle"
  },
  "5-6": {
    textSize: "large",
    theme: "dark_calm",
    correctEffects: { intensity: "medium", variation: "high" } as AppSettings["correctEffects"],
    animationSpeed: 1.1,
    maxAllowedLevel: 5,
    mistakeStyle: "normal"
  },
  custom: {
    maxAllowedLevel: 5
  }
};
function withAuthHeaders(base: Record<string, string> = {}) {
  return base;
}

class ApiError extends Error {
  status?: number;
  code?: string;
  requestId?: string;
  url?: string;
  details?: any;
}

async function parseApiError(res: Response, fallback: string) {
  const requestId = res.headers.get("x-request-id") || undefined;
  try {
    const data = await res.json();
    const err = new ApiError(String(data?.error || data?.message || fallback));
    err.status = res.status;
    err.code = data?.code;
    err.requestId = data?.requestId || requestId;
    err.url = res.url;
    err.details = data;
    return err;
  } catch {
    try {
      const text = await res.text();
      const err = new ApiError(text ? String(text) : fallback);
      err.status = res.status;
      err.requestId = requestId;
      err.url = res.url;
      return err;
    } catch {
      const err = new ApiError(fallback);
      err.status = res.status;
      err.requestId = requestId;
      err.url = res.url;
      return err;
    }
  }
}

const API = {
  async generateTasks(level: number, count: number, contentMode: ContentMode, language = "en"): Promise<{ tasks: Task[]; language: string; fallbackNotice?: string | null }> {
    const res = await fetch("/api/tasks/generate", {
      method: "POST",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ level, count, contentMode, language })
    });
    if (!res.ok) throw await parseApiError(res, "Failed to generate tasks");
    return res.json();
  },
  async saveResult(payload: any) {
    const res = await fetch("/api/results", {
      method: "POST",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw await parseApiError(res, "Failed to save result");
    return res.json();
  },
  async getLeaderboard(filters: any): Promise<{ entries: LeaderboardEntry[]; myRank: number | null }> {
    const params = new URLSearchParams(filters).toString();
    const res = await fetch(`/api/leaderboard?${params}`, { headers: withAuthHeaders() });
    if (!res.ok) throw await parseApiError(res, "Failed to load leaderboard");
    const data = await res.json();
    return {
      entries: data.entries as LeaderboardEntry[],
      myRank: typeof data.myRank === "number" ? data.myRank : null
    };
  },
  async getPublicSession() {
    const res = await fetch("/api/public/session", { headers: withAuthHeaders() });
    if (!res.ok) throw await parseApiError(res, "Failed to load session");
    return res.json();
  },
  async getUserProfile() {
    const res = await fetch("/api/user/profile", { headers: withAuthHeaders() });
    if (!res.ok) throw await parseApiError(res, "Failed to load profile");
    return res.json();
  },
  async updateUserProfile(payload: { displayName: string; avatarUrl?: string }) {
    const res = await fetch("/api/user/profile", {
      method: "PUT",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw await parseApiError(res, "Failed to update profile");
    return res.json();
  },
  async checkDisplayNameAvailability(name: string) {
    const params = new URLSearchParams({ name });
    const res = await fetch(`/api/user/display-name/availability?${params.toString()}`, { headers: withAuthHeaders() });
    if (!res.ok) throw await parseApiError(res, "Failed to check display name");
    return res.json();
  },
  async changePassword(payload: { currentPassword: string; newPassword: string }) {
    const res = await fetch("/api/user/password", {
      method: "PUT",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw await parseApiError(res, "Failed to update password");
    return res.json();
  },
  async getOwnOpenAIKeyStatus() {
    const res = await fetch("/api/user/openai-key/status", { headers: withAuthHeaders() });
    if (!res.ok) throw await parseApiError(res, "Failed to load OpenAI key status");
    return res.json();
  },
  async saveOwnOpenAIKey(apiKey: string) {
    const res = await fetch("/api/user/openai-key", {
      method: "PUT",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ apiKey })
    });
    if (!res.ok) throw await parseApiError(res, "Failed to save OpenAI key");
    return res.json();
  },
  async getHealth() {
    const res = await fetch("/api/health");
    if (!res.ok) throw await parseApiError(res, "Failed to load health");
    return res.json();
  },
  async getPublicVersion() {
    const res = await fetch("/api/public/version");
    if (!res.ok) throw await parseApiError(res, "Failed to load public version");
    return res.json();
  },
  async getSetupStatus() {
    const res = await fetch("/api/setup/status", { headers: withAuthHeaders() });
    if (!res.ok) throw await parseApiError(res, "Failed to load setup status");
    return res.json();
  },
  async getPublicConfigStatus() {
    const res = await fetch("/api/public/config/status", { headers: withAuthHeaders() });
    if (!res.ok) throw await parseApiError(res, "Failed to load public config status");
    return res.json();
  },
  async completeSetup() {
    const res = await fetch("/api/setup/complete", { method: "POST", headers: withAuthHeaders() });
    if (!res.ok) throw await parseApiError(res, "Failed to complete setup");
    return res.json();
  },
  async setupCreateAdmin(payload: { email: string; displayName: string; password: string }) {
    const res = await fetch("/api/setup/admin-user", {
      method: "POST",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw await parseApiError(res, "Failed to create setup admin");
    return res.json();
  },
  async getSetupDbStatus() {
    const res = await fetch("/api/setup/db-status", { headers: withAuthHeaders() });
    if (!res.ok) throw await parseApiError(res, "Failed to load setup database status");
    return res.json();
  },
  async bootstrapOwner() {
    const res = await fetch("/api/setup/bootstrap-owner", { method: "POST", headers: withAuthHeaders() });
    if (!res.ok) throw await parseApiError(res, "Failed to bootstrap owner");
    return res.json();
  },
  async getAuthProviders() {
    const res = await fetch("/api/auth/providers");
    if (!res.ok) throw await parseApiError(res, "Failed to load providers");
    return res.json();
  },
  async authWithGoogle(credential: string) {
    const res = await fetch("/api/auth/google", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential })
    });
    if (!res.ok) throw await parseApiError(res, "Google sign-in failed");
    return res.json();
  },
  async registerWithPassword(payload: { email: string; displayName: string; password: string }) {
    const res = await fetch("/api/auth/register", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw await parseApiError(res, "Registration failed");
    return res.json();
  },
  async loginWithPassword(payload: { email: string; password: string }) {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw await parseApiError(res, "Invalid email or password");
    return res.json();
  },
  async requestPasswordReset(email: string) {
    const res = await fetch("/api/auth/password-reset/request", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });
    if (!res.ok) throw await parseApiError(res, "Password reset request failed");
    return res.json();
  },
  async confirmPasswordReset(payload: { token: string; password: string }) {
    const res = await fetch("/api/auth/password-reset/confirm", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw await parseApiError(res, "Password reset failed");
    return res.json();
  },
  async logout() {
    const res = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", headers: withAuthHeaders() });
    if (!res.ok) throw await parseApiError(res, "Logout failed");
    return res.json();
  },
  async getAvailableLanguages(level: number) {
    const res = await fetch(`/api/packs/languages?level=${level}`, { headers: withAuthHeaders() });
    if (!res.ok) throw await parseApiError(res, "Failed to load available languages");
    return res.json();
  },
  async getLiveStats() {
    const res = await fetch("/api/live/stats", { headers: withAuthHeaders() });
    if (!res.ok) throw await parseApiError(res, "Failed to load live stats");
    return res.json();
  },
  async heartbeat(sessionId: string, mode: Mode) {
    const res = await fetch("/api/live/heartbeat", {
      method: "POST",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ sessionId, mode })
    });
    if (!res.ok) throw await parseApiError(res, "Heartbeat failed");
    return res.json();
  },
  async adminReset(scope: string, _pin?: string) {
    const res = await fetch("/api/admin/reset", {
      method: "POST",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ scope })
    });
    if (!res.ok) throw await parseApiError(res, "Reset failed");
  },
  async adminSeedDefaults(_pin?: string) {
    const res = await fetch("/api/admin/seed-defaults", {
      method: "POST",
      headers: withAuthHeaders({ "Content-Type": "application/json" })
    });
    if (!res.ok) throw await parseApiError(res, "Seed failed");
  },
  async getLanguagePacks(filters: any = {}) {
    const params = new URLSearchParams(filters).toString();
    const res = await fetch(`/api/admin/language-packs?${params}`, { headers: withAuthHeaders() });
    if (!res.ok) throw await parseApiError(res, "Failed to load language packs");
    return res.json();
  },
  async getVocabPacks(): Promise<VocabPack[]> {
    const data = await this.getLanguagePacks({});
    const packs = Array.isArray(data.packs) ? data.packs : [];
    return packs.map((pack: any) => ({
      id: pack.id,
      name: `${pack.language.toUpperCase()} ${pack.type} (${pack.status})`,
      packType: pack.type,
      items: Array.isArray(pack.items) ? pack.items.map((i: any) => i.text || i) : [],
      active: pack.status === "PUBLISHED" ? 1 : 0,
      createdAt: pack.createdAt || pack.createdat || new Date().toISOString()
    }));
  },
  async deleteVocabPack(id: number, _pin?: string) {
    return this.updateLanguagePack(id, { status: "ARCHIVED" });
  },
  async activateVocabPack(id: number, _pin?: string) {
    return this.updateLanguagePack(id, { status: "PUBLISHED" });
  },
  async updateVocabPack(id: number, payload: any, _pin?: string) {
    return this.updateLanguagePack(id, payload);
  },
  async generateVocab(payload: any, _pin?: string) {
    return this.generateLanguagePack(payload);
  },
  async testOpenAI(payload: any, _pin?: string) {
    const res = await fetch("/api/admin/openai/test", {
      method: "POST",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw await parseApiError(res, "Test failed");
    return res.json();
  },
  async updateLanguagePack(id: number, payload: any) {
    const res = await fetch(`/api/admin/language-packs/${id}`, {
      method: "PUT",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw await parseApiError(res, "Language pack update failed");
    return res.json();
  },
  async generateLanguagePack(payload: any) {
    const res = await fetch("/api/admin/language-packs/generate", {
      method: "POST",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw await parseApiError(res, "Language pack generation failed");
    return res.json();
  },
  async exportLanguagePacks() {
    const res = await fetch("/api/admin/language-packs/export", { headers: withAuthHeaders() });
    if (!res.ok) throw await parseApiError(res, "Language pack export failed");
    return res.json();
  },
  async importLanguagePacks(payload: any) {
    const res = await fetch("/api/admin/language-packs/import", {
      method: "POST",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw await parseApiError(res, "Language pack import failed");
    return res.json();
  },
  async getDbStatus(_pin?: string): Promise<DbAdminStatus> {
    const res = await fetch("/api/admin/db/status", { headers: withAuthHeaders() });
    if (!res.ok) throw await parseApiError(res, "Failed to load DB status");
    return res.json();
  },
  async getDbConfig(_pin?: string): Promise<{ dbConfig: DbAdminConfig; activeDriver: "sqlite" | "postgres" }> {
    const res = await fetch("/api/admin/db/config", { headers: withAuthHeaders() });
    if (!res.ok) throw await parseApiError(res, "Failed to load DB config");
    return res.json();
  },
  async saveDbConfig(_pinOrPayload: any, payloadOrVerify?: any, verify = true) {
    const payload = typeof _pinOrPayload === "object" ? _pinOrPayload : payloadOrVerify;
    const finalVerify = typeof payloadOrVerify === "boolean" ? payloadOrVerify : verify;
    const res = await fetch("/api/admin/db/config", {
      method: "POST",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ ...payload, verify: finalVerify })
    });
    if (!res.ok) throw await parseApiError(res, "Failed to save DB config");
    return res.json();
  },
  async switchDb(pinOrTarget: any, maybeTarget?: "sqlite" | "postgres") {
    const target = (maybeTarget || pinOrTarget) as "sqlite" | "postgres";
    const res = await fetch("/api/admin/db/switch", {
      method: "POST",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ target, mode: "copy-then-switch", verify: true })
    });
    if (!res.ok) throw await parseApiError(res, "DB switch failed");
    return res.json();
  },
  async rollbackDb(_pin?: string) {
    const res = await fetch("/api/admin/db/rollback", {
      method: "POST",
      headers: withAuthHeaders()
    });
    if (!res.ok) throw await parseApiError(res, "DB rollback failed");
    return res.json();
  },
  async testDbConnection(pinOrPayload: any, maybePayload?: { postgres: DbAdminConfig["postgres"] }) {
    const payload = (maybePayload || pinOrPayload) as { postgres: DbAdminConfig["postgres"] };
    const res = await fetch("/api/admin/db/test", {
      method: "POST",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw await parseApiError(res, "Postgres test connection failed");
    return res.json();
  },
  async getAdminPinStatus(_pin?: string): Promise<{ pinIsDefault: boolean; source: string }> {
    return { pinIsDefault: false, source: "removed_use_rbac" };
  },
  async changeAdminPin(_pin: string, _currentPin: string, _newPin: string) {
    throw new Error("Admin PIN has been removed. Use admin user authorization.");
  },
  async getServiceSettings() {
    const res = await fetch("/api/admin/service-settings", { headers: withAuthHeaders() });
    if (!res.ok) throw await parseApiError(res, "Failed to load service settings");
    return res.json();
  },
  async getAdminConfigStatus(): Promise<{ status: ConfigStatus }> {
    const res = await fetch("/api/admin/config/status", { headers: withAuthHeaders() });
    if (!res.ok) throw await parseApiError(res, "Failed to load config status");
    return res.json();
  },
  async applyAdminConfig(changes: Array<{ key: string; valueJson: any; scope?: string; scopeId?: string }>, allowPartialSetup = false) {
    const res = await fetch("/api/admin/config/apply", {
      method: "POST",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ changes, allowPartialSetup })
    });
    if (!res.ok) throw await parseApiError(res, "Failed to apply config");
    return res.json();
  },
  async testSmtpConfig(payload: { to?: string; settings?: any }) {
    const res = await fetch("/api/admin/config/test/smtp", {
      method: "POST",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload || {})
    });
    if (!res.ok) throw await parseApiError(res, "SMTP test failed");
    return res.json();
  },
  async testGoogleConfig() {
    const res = await fetch("/api/admin/config/test/google", { method: "POST", headers: withAuthHeaders() });
    if (!res.ok) throw await parseApiError(res, "Google config test failed");
    return res.json();
  },
  async testDatabaseConfig() {
    const res = await fetch("/api/admin/config/test/db", { method: "POST", headers: withAuthHeaders() });
    if (!res.ok) throw await parseApiError(res, "Database test failed");
    return res.json();
  },
  async saveEmailSettings(payload: any) {
    const res = await fetch("/api/admin/service-settings/email", {
      method: "POST",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw await parseApiError(res, "Failed to save email settings");
    return res.json();
  },
  async saveGoogleAuthSettings(payload: { enabled: boolean; clientId: string; clientSecret?: string }) {
    const res = await fetch("/api/admin/service-settings/auth/google", {
      method: "POST",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw await parseApiError(res, "Failed to save Google auth settings");
    return res.json();
  },
  async sendTestEmail(to: string) {
    const res = await fetch("/api/admin/service-settings/email/test", {
      method: "POST",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ to })
    });
    if (!res.ok) throw await parseApiError(res, "Failed to send test email");
    return res.json();
  },
  async listCrashEvents(limit = 50, unresolvedOnly = false) {
    const res = await fetch(`/api/admin/crashes?limit=${limit}&unresolvedOnly=${unresolvedOnly ? "true" : "false"}`, {
      headers: withAuthHeaders()
    });
    if (!res.ok) throw await parseApiError(res, "Failed to load crashes");
    return res.json();
  },
  async getCrashEvent(id: number) {
    const res = await fetch(`/api/admin/crashes/${id}`, { headers: withAuthHeaders() });
    if (!res.ok) throw await parseApiError(res, "Failed to load crash details");
    return res.json();
  },
  async acknowledgeCrashEvent(id: number) {
    const res = await fetch(`/api/admin/crashes/${id}/ack`, { method: "POST", headers: withAuthHeaders() });
    if (!res.ok) throw await parseApiError(res, "Failed to acknowledge crash");
    return res.json();
  },
  async getSettings(_pin?: string): Promise<AppSettings> {
    const res = await fetch("/api/settings", { headers: withAuthHeaders() });
    if (!res.ok) throw await parseApiError(res, "Failed to load settings");
    const data = await res.json();
    return data.settings as AppSettings;
  },
  async saveSettings(payload: AppSettings, _pin?: string): Promise<AppSettings> {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw await parseApiError(res, "Failed to save settings");
    const data = await res.json();
    return data.settings as AppSettings;
  }
};

type AppSelectProps = React.ComponentProps<typeof MantineSelect>;

function Select(props: AppSelectProps) {
  const { comboboxProps, ...rest } = props;
  return (
    <MantineSelect
      {...rest}
      searchable={false}
      checkIconPosition="right"
      comboboxProps={{
        withinPortal: true,
        width: "target",
        position: "bottom-start",
        offset: 6,
        ...comboboxProps
      }}
    />
  );
}

const SOUND_FILES: Record<SoundName, string> = {
  chime: "/sounds/chime.wav",
  pop: "/sounds/pop.wav",
  bell: "/sounds/bell.wav",
  sparkle: "/sounds/sparkle.wav",
  off: ""
};

function useSoundBank(volume: number, muted: boolean) {
  const cacheRef = useRef<Record<string, HTMLAudioElement>>({});

  const play = useCallback((sound: SoundName) => {
    if (muted || sound === "off") return;
    const src = SOUND_FILES[sound];
    if (!src) return;
    let audio = cacheRef.current[src];
    if (!audio) {
      audio = new Audio(src);
      cacheRef.current[src] = audio;
    }
    audio.currentTime = 0;
    // Safety: Cap max volume at 0.75 to protect toddler hearing
    audio.volume = Math.min(Math.max(volume, 0), 0.75);
    // Gracefully handle autoplay policy failures (browser may block audio without user gesture)
    audio.play().catch(() => {
      // Silent fail - toddler game continues without sound rather than crashing
    });
  }, [muted, volume]);

  return { play };
}

function calcAccuracy(correct: number, incorrect: number) {
  const total = correct + incorrect;
  return total === 0 ? 0 : Math.round((correct / total) * 100);
}

function calcCPM(correct: number, elapsedMs: number) {
  const minutes = Math.max(elapsedMs / 60000, 1 / 60);
  return Math.round(correct / minutes);
}

function settingsKey(settings: GameSettings) {
  return `run_${settings.mode}_${settings.level}_${settings.contestType}_${settings.duration}_${settings.taskTarget}_${settings.contentMode}_${settings.language}`;
}

const TEXT_SCALE: Record<TextSize, number> = {
  small: 0.95,
  medium: 1.1,
  large: 1.35,
  xlarge: 1.6
};

const VISUAL_SET_FILES: Record<VisualSet, string> = {
  stars: "/effects/stars.svg",
  hearts: "/effects/hearts.svg",
  balloons: "/effects/balloons.svg",
  smiles: "/effects/smiles.svg",
  confetti: "/effects/confetti.svg"
};

const SOUND_OPTIONS: SoundName[] = ["chime", "pop", "bell", "sparkle"];

const INTENSITY_CONFIG: Record<Intensity, { count: number; size: number; speed: number; volume: number }> = {
  very_low: { count: 6, size: 28, speed: 0.8, volume: 0.25 },
  low: { count: 10, size: 34, speed: 0.9, volume: 0.35 },
  medium: { count: 16, size: 42, speed: 1, volume: 0.5 },
  high: { count: 24, size: 52, speed: 1.2, volume: 0.7 }
};

const BASE_FIT: Omit<FitConfig, "scale" | "min" | "max" | "allowWrap"> = {
  lineHeight: 1.05,
  letterSpacing: 0.06
};

function hexToRgb(hex: string) {
  const match = hex.replace("#", "");
  const num = parseInt(match, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255
  };
}

function blend(hexA: string, hexB: string, amount: number) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  const mix = (x: number, y: number) => Math.round(x + (y - x) * amount);
  return `#${[mix(a.r, b.r), mix(a.g, b.g), mix(a.b, b.b)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function computeTheme(settings: AppSettings) {
  const base = settings.theme === "custom" ? settings.customTheme : themePresets[settings.theme];
  const flat = settings.flatTheme;
  if (!settings.lowStimulation) return { ...base, flat };
  const softBase = "#f3efe6";
  return {
    background: blend(base.background, softBase, 0.35),
    backgroundAlt: blend(base.backgroundAlt, softBase, 0.35),
    panel: blend(base.panel, softBase, 0.25),
    text: blend(base.text, "#2b2b2b", 0.2),
    mutedText: blend(base.mutedText, "#2b2b2b", 0.3),
    accent: blend(base.accent, softBase, 0.4),
    highlight: blend(base.highlight, softBase, 0.4),
    correct: blend(base.correct, softBase, 0.4),
    mistake: blend(base.mistake, softBase, 0.5),
    flat
  };
}

function makeFitConfig({
  scale,
  autoFit,
  allowWrap,
  variant
}: {
  scale: number;
  autoFit: boolean;
  allowWrap: boolean;
  variant: "current" | "preview" | "secondary";
}): FitConfig {
  const sizeBoost = autoFit ? 1 : 0.9;
  if (variant === "secondary") {
    return {
      ...BASE_FIT,
      scale: scale * 0.6 * sizeBoost,
      min: 56,
      max: 260,
      allowWrap
    };
  }
  if (variant === "preview") {
    return {
      ...BASE_FIT,
      scale: scale * sizeBoost,
      min: 88,
      max: 520,
      allowWrap
    };
  }
  return {
    ...BASE_FIT,
    scale: scale * sizeBoost,
    min: 120,
    max: 760,
    allowWrap
  };
}

function seededRandom(seed: number) {
  let x = Math.sin(seed) * 10000;
  return () => {
    x = Math.sin(x) * 10000;
    return x - Math.floor(x);
  };
}

function usePrefersReducedMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduce(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduce;
}

function classifyKey(event: KeyboardEvent) {
  const key = event.key;
  if (key === " ") return "space";
  if (/^F\d{1,2}$/.test(key)) return "function";
  if (["Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock"].includes(key)) return "modifier";
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(key)) return "navigation";
  if (["Tab", "Escape", "Enter", "Backspace", "Delete", "Insert"].includes(key)) return "navigation";
  if (key.length === 1 && /[\p{L}\p{N}]/u.test(key)) return "alphaNum";
  if (key.length === 1) return "punct";
  return "other";
}

function renderZeroStyledText(text: string, settings: AppSettings) {
  if (!settings.differentiateZero) return text;
  return text.split("").map((char, idx) => {
    if (char === " ") return " ";
    if (char === "0") {
      const styleClass = settings.zeroStyle === "dotted"
        ? "zero-dotted"
        : settings.zeroStyle === "slashed"
          ? "zero-slashed"
          : "zero-dot";
      return (
        <span key={`zero-${idx}`} className={`zero ${styleClass}`}>
          0
        </span>
      );
    }
    return <span key={`char-${idx}`}>{char}</span>;
  });
}

function buildParticles(count: number, seed: number, variation: Variation) {
  const rand = variation === "same" ? seededRandom(42) : seededRandom(seed);
  const spread = variation === "small" ? 0.6 : 1;
  const sizeScale = variation === "small" ? 0.7 : 1;
  return Array.from({ length: count }, (_, idx) => {
    const r = rand();
    return {
      id: `${seed}-${idx}`,
      x: 20 + r * 60 * spread,
      y: 20 + rand() * 40 * spread,
      size: 18 + rand() * 28 * sizeScale,
      delay: rand() * 0.2,
      rotate: rand() * 30 - 15
    };
  });
}
function App() {
  const PLAY_SESSION_KEY = "ktrain_play_session_id_v2";
  const [screen, setScreen] = useState<Screen>("home");
  const [settings, setSettings] = useState<GameSettings>(defaultSettings);
  const [appSettings, setAppSettings] = useState<AppSettings>(defaultAppSettings);
  const [savedAppSettings, setSavedAppSettings] = useState<AppSettings>(defaultAppSettings);
  const [lastSettingsAppliedAt, setLastSettingsAppliedAt] = useState<string>("");
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [buffer, setBuffer] = useState("");
  const [caretIndex, setCaretIndex] = useState(0);
  const [progress, setProgress] = useState<Array<"correct" | "wrong" | "pending">>([]);
  const [expectSpace, setExpectSpace] = useState(false);
  const [taskHadMistake, setTaskHadMistake] = useState(false);
  const [gameStats, setGameStats] = useState<GameStats>({
    correct: 0,
    incorrect: 0,
    tasksCompleted: 0,
    streak: 0,
    maxStreak: 0
  });
  const [startTime, setStartTime] = useState<number>(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [showEffects, setShowEffects] = useState(false);
  const [effectTick, setEffectTick] = useState(0);
  const [effectSeed, setEffectSeed] = useState(1);
  const [correctFlash, setCorrectFlash] = useState(false);
  const [mistakeFlash, setMistakeFlash] = useState(false);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [prevAccuracy, setPrevAccuracy] = useState<number>(0);
  const [adminPin, setAdminPin] = useState("");
  const [packs, setPacks] = useState<VocabPack[]>([]);
  const [statusMessage, setStatusMessage] = useState("");
  const [currentFit, setCurrentFit] = useState<FitMetrics | null>(null);
  const [compactUI, setCompactUI] = useState(false);
  const [langMismatchCount, setLangMismatchCount] = useState(0);
  const [langMismatchTs, setLangMismatchTs] = useState(0);
  const [showLangBanner, setShowLangBanner] = useState(false);
  const [langDismissed, setLangDismissed] = useState(false);
  const [functionKeyNotice, setFunctionKeyNotice] = useState("");
  const [lastFunctionKey, setLastFunctionKey] = useState("");
  const [lastFunctionKeyTime, setLastFunctionKeyTime] = useState(0);
  const [showZeroHint, setShowZeroHint] = useState(false);
  const [showStopModal, setShowStopModal] = useState(false);
  const [showUnsavedSettingsModal, setShowUnsavedSettingsModal] = useState(false);
  const [pendingScreen, setPendingScreen] = useState<Screen | null>(null);
  const [setupStatus, setSetupStatus] = useState<any>(null);
  // WHY: setup modal visibility is derived from backend ConfigStatus, not local wizard flags.
  const [setupWizardOpen, setSetupWizardOpen] = useState(false);
  const [setupMessage, setSetupMessage] = useState("");
  const [setupAdminEmail, setSetupAdminEmail] = useState("");
  const [setupAdminName, setSetupAdminName] = useState("");
  const [setupAdminPassword, setSetupAdminPassword] = useState("");
  const [publicConfigOverall, setPublicConfigOverall] = useState<ConfigOverall>("READY");
  const [setupDbStatus, setSetupDbStatus] = useState<any>(null);
  const [clientErrors, setClientErrors] = useState<ClientErrorTrace[]>([]);
  const [errorLogOpen, setErrorLogOpen] = useState(false);
  const [savePartial, setSavePartial] = useState(false);
  const [levelConverted, setLevelConverted] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authDisplayName, setAuthDisplayName] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register" | "forgot">("login");
  const [authMessage, setAuthMessage] = useState("");
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [passwordResetToken, setPasswordResetToken] = useState("");
  const [passwordResetPassword, setPasswordResetPassword] = useState("");
  const [sessionUser, setSessionUser] = useState<any>(null);
  const [availableLanguages, setAvailableLanguages] = useState<string[]>(["en", "ru"]);
  const [liveStats, setLiveStats] = useState<{ total: number; authorized: number; guests: number; modes?: Array<{ mode: string; count: number }> }>({
    total: 0,
    authorized: 0,
    guests: 0,
    modes: []
  });
  const [playSessionId, setPlaySessionId] = useState<string>("");
  const [googleClientId, setGoogleClientId] = useState("");
  const [passwordResetEnabled, setPasswordResetEnabled] = useState(false);
  const [myRank, setMyRank] = useState<number | null>(null);
  const [appMode, setAppMode] = useState<string>("info");
  const [publicVersion, setPublicVersion] = useState<PublicVersion | null>(null);
  const isAdminUser = Boolean(sessionUser && ["ADMIN", "OWNER"].includes(String(sessionUser.role || "").toUpperCase()));
  const baseTheme = computeTheme(appSettings);
  const contrastResult = useMemo(
    () => applyVisibilityGuard(
      {
        background: baseTheme.background,
        backgroundAlt: baseTheme.backgroundAlt,
        surface: baseTheme.panel,
        text: baseTheme.text,
        mutedText: baseTheme.mutedText,
        accent: baseTheme.accent,
        highlight: baseTheme.highlight,
        correct: baseTheme.correct,
        mistake: baseTheme.mistake,
        flat: baseTheme.flat
      },
      appSettings.visibilityGuard
    ),
    [baseTheme, appSettings.visibilityGuard]
  );
  const theme = {
    ...baseTheme,
    ...contrastResult.theme
  };
  const contrastReport = contrastResult.report;
  const intensity = appSettings.lowStimulation ? "very_low" : appSettings.correctEffects.intensity;
  const sound = useSoundBank(appSettings.correctEffects.volume * INTENSITY_CONFIG[intensity].volume, !appSettings.soundEnabled);
  const textScale = TEXT_SCALE[appSettings.textSize];
  const fitConfigCurrent = useMemo(
    () => makeFitConfig({ scale: textScale, autoFit: appSettings.autoFitText, allowWrap: false, variant: "current" }),
    [textScale, appSettings.autoFitText]
  );
  const fitConfigSecondary = useMemo(
    () => makeFitConfig({ scale: textScale, autoFit: appSettings.autoFitText, allowWrap: false, variant: "secondary" }),
    [textScale, appSettings.autoFitText]
  );
  const fitConfigSentence = useMemo(
    () => makeFitConfig({ scale: textScale * 0.6, autoFit: appSettings.autoFitText, allowWrap: true, variant: "preview" }),
    [textScale, appSettings.autoFitText]
  );

  const currentTask = tasks[currentIndex];
  const prevTask = tasks[currentIndex - 1];
  const nextTask = tasks[currentIndex + 1];

  const accuracy = calcAccuracy(gameStats.correct, gameStats.incorrect);
  const cpm = calcCPM(gameStats.correct, elapsedMs);
  const incorrectRatio = gameStats.correct === 0 ? 0 : Number((gameStats.incorrect / gameStats.correct).toFixed(2));

  const score = useMemo(() => {
    if (settings.mode !== "contest") return 0;
    if (settings.contestType === "time") {
      return Math.round(gameStats.tasksCompleted * 100 + accuracy * 10 + gameStats.maxStreak * 5);
    }
    const timeSec = Math.max(Math.round(elapsedMs / 1000), 1);
    return Math.round(100000 / timeSec + accuracy * 10 + gameStats.maxStreak * 5);
  }, [settings, gameStats, accuracy, elapsedMs]);

  const trendDelta = Math.round(accuracy - prevAccuracy);
  const trendLabel = trendDelta === 0 ? "" : trendDelta > 0 ? `+${trendDelta}%` : `${trendDelta}%`;
  const stars = gameStats.streak > 0
    ? "*".repeat(Math.min(5, Math.max(1, Math.floor(gameStats.streak / 3) + 1)))
    : "0";
  const allowedLevels = buildAllowedLevels(appSettings.maxAllowedLevel || 5);
  const hasUnsavedSettings = useMemo(
    () => JSON.stringify(appSettings) !== JSON.stringify(savedAppSettings),
    [appSettings, savedAppSettings]
  );
  const isSetupRoute = window.location.pathname === "/setup";
  const isSetupRequired = publicConfigOverall === "SETUP_REQUIRED";

  const reportClientError = useCallback((action: string, err: any) => {
    const apiErr = err as ApiError;
    const trace: ClientErrorTrace = {
      at: new Date().toISOString(),
      action,
      message: String(apiErr?.message || err || "Unknown error"),
      status: apiErr?.status,
      code: apiErr?.code,
      requestId: apiErr?.requestId,
      url: apiErr?.url,
      stack: typeof apiErr?.stack === "string" ? apiErr.stack : undefined,
      details: apiErr?.details
    };
    setClientErrors((prev) => [trace, ...prev].slice(0, 50));
  }, []);
  const themeVars = {
    "--bg": theme.background,
    "--bg-alt": theme.backgroundAlt,
    "--surface": theme.panel,
    "--text": theme.text,
    "--muted": theme.mutedText,
    "--accent": theme.accent,
    "--button-text": theme.buttonText || "#1a1a1a",
    "--highlight": theme.highlight,
    "--correct": theme.correct,
    "--mistake": theme.mistake,
    "--switch-off": theme.switchOff || theme.panel,
    "--switch-on": theme.switchOn || theme.accent,
    "--switch-thumb": theme.switchThumb || theme.text,
    "--slider-track": theme.sliderTrack || theme.accent,
    "--slider-thumb": theme.sliderThumb || theme.text,
    "--modal-surface": theme.panel,
    "--modal-text": theme.text,
    "--modal-muted": theme.mutedText,
    "--modal-border": "rgba(255, 255, 255, 0.14)",
    "--modal-overlay": "rgba(8, 10, 18, 0.66)"
  } as React.CSSProperties;

  useEffect(() => {
    Object.entries(themeVars).forEach(([key, value]) => {
      if (typeof value === "string") {
        document.documentElement.style.setProperty(key, value);
      }
    });
  }, [themeVars]);

  const applySettings = useCallback(async () => {
    if (!adminPin) return false;
    try {
      const saved = await API.saveSettings(appSettings, adminPin);
      setSavedAppSettings(saved);
      setAppSettings(saved);
      setLastSettingsAppliedAt(new Date().toISOString());
      setStatusMessage("Settings applied.");
      return true;
    } catch {
      setStatusMessage("Failed to apply settings.");
      return false;
    }
  }, [adminPin, appSettings]);

  const resetSettingsDraft = useCallback(() => {
    setAppSettings(savedAppSettings);
    setStatusMessage("Unsaved changes discarded.");
  }, [savedAppSettings]);

  const navigateFromSettings = useCallback((next: Screen) => {
    if (screen === "settings" && hasUnsavedSettings) {
      setPendingScreen(next);
      setShowUnsavedSettingsModal(true);
      return;
    }
    setScreen(next);
  }, [screen, hasUnsavedSettings]);

  const handleBrandClick = () => {
    if (screen === "game") {
      setSavePartial(false);
      setShowStopModal(true);
      return;
    }
    if (window.location.pathname === "/about") {
      window.history.pushState({}, "", "/");
    }
    if (screen !== "home") {
      navigateFromSettings("home");
    }
  };

  useEffect(() => {
    if (window.location.pathname === "/about") {
      setScreen("about");
    }
  }, []);

  useEffect(() => {
    if (screen !== "about" && window.location.pathname === "/about") {
      window.history.replaceState({}, "", "/");
    }
  }, [screen]);

  useEffect(() => {
    if (isSetupRoute || isSetupRequired) return;
    API.getPublicSession()
      .then((session) => {
        setSessionUser(session.actor?.isAuthenticated ? session.actor : null);
      })
      .catch((err) => {
        setSessionUser(null);
        reportClientError("load_public_session", err);
      });

    const params = new URLSearchParams(window.location.search);
    const resetToken = params.get("reset_token");
    if (resetToken) {
      setPasswordResetToken(resetToken);
      setAuthMode("forgot");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [isSetupRoute, isSetupRequired, reportClientError]);

  useEffect(() => {
    API.getPublicConfigStatus()
      .then((status) => {
        setPublicConfigOverall((status?.overall || "READY") as ConfigOverall);
        if (status?.setupRequired) setSetupWizardOpen(true);
      })
      .catch(() => {
        setPublicConfigOverall("SETUP_REQUIRED");
        setSetupWizardOpen(true);
        reportClientError("load_public_config_status", new Error("Failed to load public config status"));
      });
  }, [reportClientError]);

  useEffect(() => {
    if (isSetupRoute || isSetupRequired) return;
    API.getAuthProviders()
      .then((providers) => {
        const cid = providers?.google?.enabled ? providers.google.clientId || "" : "";
        setGoogleClientId(cid);
        setPasswordResetEnabled(Boolean(providers?.password?.resetEnabled));
      })
      .catch(() => {
        setGoogleClientId("");
        setPasswordResetEnabled(false);
        reportClientError("load_auth_providers", new Error("Failed to load auth providers"));
      });
  }, [isSetupRoute, isSetupRequired, reportClientError]);

  const refreshSetupStatus = useCallback(async () => {
    try {
      const data = await API.getSetupStatus();
      setSetupStatus(data);
      const overall = (data?.overall || (data?.wizardCompleted ? "READY" : "SETUP_REQUIRED")) as ConfigOverall;
      setPublicConfigOverall(overall);
      setSetupWizardOpen(Boolean(data?.setupRequired) || !Boolean(data?.wizardCompleted));
      if (Boolean(data?.setupRequired)) {
        const db = await API.getSetupDbStatus().catch(() => null);
        setSetupDbStatus(db);
      } else {
        setSetupDbStatus(null);
        if (window.location.pathname === "/setup") {
          setSetupMessage("Setup is completed. Open Settings/Admin for optional configuration.");
        }
      }
    } catch {
      setSetupStatus(null);
      reportClientError("refresh_setup_status", new Error("Failed to refresh setup status"));
    }
  }, [reportClientError]);

  useEffect(() => {
    refreshSetupStatus().catch(() => null);
  }, [refreshSetupStatus, sessionUser]);

  useEffect(() => {
    if (isSetupRoute || isSetupRequired) return;
    API.getHealth()
      .then((health) => setAppMode(String(health?.appMode || "info")))
      .catch((err) => {
        setAppMode("info");
        reportClientError("load_health", err);
      });
  }, [isSetupRoute, isSetupRequired, reportClientError]);

  useEffect(() => {
    if (isSetupRoute || isSetupRequired) return;
    API.getPublicVersion()
      .then((data) => setPublicVersion({
        version: String(data?.version || "0.0.0"),
        build: String(data?.build || "0"),
        commit: String(data?.commit || "unknown"),
        buildTime: data?.buildTime || null,
        githubUrl: data?.githubUrl,
        website: data?.website,
        contact: data?.contact,
        appMode: data?.appMode
      }))
      .catch((err) => {
        setPublicVersion(null);
        reportClientError("load_public_version", err);
      });
  }, [isSetupRoute, isSetupRequired, reportClientError]);

  useEffect(() => {
    if (isAdminUser) setAdminPin("rbac");
    else setAdminPin("");
  }, [isAdminUser]);

  useEffect(() => {
    if (!googleClientId) return;
    const scriptId = "google-identity-service";
    const existing = document.getElementById(scriptId) as HTMLScriptElement | null;
    const init = () => {
      const w = window as any;
      if (!w.google?.accounts?.id) return;
      w.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: (response: any) => {
          if (response?.credential) void handleGoogleCredential(response.credential);
        }
      });
      const target = document.getElementById("google-signin-button");
      if (target) {
        target.innerHTML = "";
        w.google.accounts.id.renderButton(target, { theme: "outline", size: "medium", shape: "pill" });
      }
    };

    if (existing) {
      init();
      return;
    }

    const script = document.createElement("script");
    script.id = scriptId;
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = init;
    document.body.appendChild(script);
  }, [googleClientId]);

  useEffect(() => {
    const onWindowError = (event: ErrorEvent) => {
      reportClientError("window_error", event.error || new Error(event.message || "Unhandled window error"));
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      reportClientError("unhandled_rejection", event.reason || new Error("Unhandled rejection"));
    };
    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, [reportClientError]);

  useEffect(() => {
    if (!adminPin) {
      setSettingsLoaded(true);
      return;
    }
    API.getSettings(adminPin || undefined)
      .then((loaded) => {
        const derived = deriveMaxAllowed(loaded.allowedLevels);
        const maxAllowed = typeof loaded.maxAllowedLevel === "number"
          ? loaded.maxAllowedLevel
          : derived;
        if (typeof loaded.maxAllowedLevel !== "number" && Array.isArray(loaded.allowedLevels)) {
          const maxInList = Math.max(...loaded.allowedLevels.map((n: number) => Number(n)));
          if (derived < maxInList) setLevelConverted(true);
        }
        setAppSettings({
          ...defaultAppSettings,
          ...loaded,
          maxAllowedLevel: maxAllowed,
          allowedLevels: buildAllowedLevels(maxAllowed),
          customTheme: { ...defaultAppSettings.customTheme, ...(loaded.customTheme || {}) },
          correctEffects: { ...defaultAppSettings.correctEffects, ...(loaded.correctEffects || {}) }
        });
        setSavedAppSettings({
          ...defaultAppSettings,
          ...loaded,
          maxAllowedLevel: maxAllowed,
          allowedLevels: buildAllowedLevels(maxAllowed),
          customTheme: { ...defaultAppSettings.customTheme, ...(loaded.customTheme || {}) },
          correctEffects: { ...defaultAppSettings.correctEffects, ...(loaded.correctEffects || {}) }
        });
        setLastSettingsAppliedAt(new Date().toISOString());
        setSettingsLoaded(true);
      })
      .catch(() => setSettingsLoaded(true));
  }, [adminPin]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      const contestGuard = screen === "game" && settings.mode === "contest" && appSettings.warnOnExitContest;
      const settingsGuard = screen === "settings" && hasUnsavedSettings;
      if (contestGuard || settingsGuard) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [screen, settings.mode, appSettings.warnOnExitContest, hasUnsavedSettings]);

  useEffect(() => {
    if (screen !== "game") return;
    let sid = playSessionId;
    if (!sid) {
      sid = localStorage.getItem(PLAY_SESSION_KEY) || crypto.randomUUID();
      localStorage.setItem(PLAY_SESSION_KEY, sid);
      setPlaySessionId(sid);
    }
    API.heartbeat(sid, settings.mode).catch(() => null);
    const id = window.setInterval(() => {
      API.heartbeat(sid, settings.mode).catch(() => null);
    }, 30000);
    return () => window.clearInterval(id);
  }, [screen, settings.mode, playSessionId]);

  useEffect(() => {
    const update = () => {
      setCompactUI(window.innerHeight < 700 || window.innerWidth < 700);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    const shown = localStorage.getItem("zero_hint_shown") === "1";
    setShowZeroHint(!shown);
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem(SOUND_PREF_KEY);
    if (stored === null) return;
    const enabled = stored === "true";
    setAppSettings((prev) => ({ ...prev, soundEnabled: enabled }));
  }, []);

  useEffect(() => {
    localStorage.setItem(SOUND_PREF_KEY, String(appSettings.soundEnabled));
  }, [appSettings.soundEnabled]);

  useEffect(() => {
    if (!functionKeyNotice) return;
    const id = window.setTimeout(() => setFunctionKeyNotice(""), 2500);
    return () => window.clearTimeout(id);
  }, [functionKeyNotice]);

  const resetSessionState = () => {
    setTasks([]);
    setCurrentIndex(0);
    setBuffer("");
    setCaretIndex(0);
    setProgress([]);
    setExpectSpace(false);
    setTaskHadMistake(false);
    setGameStats({ correct: 0, incorrect: 0, tasksCompleted: 0, streak: 0, maxStreak: 0 });
    setStartTime(0);
    setElapsedMs(0);
    setTimeLeft(null);
    setShowEffects(false);
    setCorrectFlash(false);
    setMistakeFlash(false);
  };

  const stopSession = async (save: boolean) => {
    if (settings.mode === "contest" && save) {
      await endGame();
      return;
    }
    resetSessionState();
    setScreen("home");
  };

  const startGame = async () => {
    setStatusMessage("");
    if (!sessionUser && !String(settings.playerName || "").trim()) {
      setStatusMessage("Guest nickname is required.");
      return;
    }
    const generated = await API.generateTasks(settings.level, 40, settings.contentMode, settings.language);
    if (generated.language !== settings.language) {
      setSettings((prev) => ({ ...prev, language: generated.language || prev.language }));
    }
    if (generated.fallbackNotice) {
      setStatusMessage(generated.fallbackNotice);
    }
    setTasks(generated.tasks);
    setCurrentIndex(0);
    setBuffer("");
    setCaretIndex(0);
    setProgress([]);
    setExpectSpace(false);
    setLangMismatchCount(0);
    setLangMismatchTs(0);
    setShowLangBanner(false);
    setLangDismissed(false);
    setGameStats({ correct: 0, incorrect: 0, tasksCompleted: 0, streak: 0, maxStreak: 0 });
    const start = Date.now();
    setStartTime(start);
    setElapsedMs(0);
    if (settings.mode === "contest" && settings.contestType === "time") {
      setTimeLeft(settings.duration * 1000);
    } else {
      setTimeLeft(null);
    }
    const prev = localStorage.getItem(settingsKey(settings));
    if (prev) {
      try {
        const parsed = JSON.parse(prev);
        if (typeof parsed.accuracy === "number") {
          setPrevAccuracy(parsed.accuracy);
        }
      } catch {
        setPrevAccuracy(0);
      }
    } else {
      setPrevAccuracy(0);
    }
    setScreen("game");
  };

  const endGame = async () => {
    const endTime = Date.now();
    const totalMs = endTime - startTime;
    const derivedPlayerName = sessionUser?.displayName || sessionUser?.email || settings.playerName || "Player";
    const result = {
      playerName: derivedPlayerName,
      contestType: settings.contestType,
      level: settings.level,
      contentMode: settings.contentMode,
      language: settings.language,
      duration: settings.mode === "contest" && settings.contestType === "time" ? settings.duration : null,
      taskTarget: settings.mode === "contest" && settings.contestType === "tasks" ? settings.taskTarget : null,
      score,
      accuracy,
      cpm,
      mistakes: gameStats.incorrect,
      tasksCompleted: gameStats.tasksCompleted,
      timeSeconds: Math.round(totalMs / 1000),
      maxStreak: gameStats.maxStreak,
      mode: settings.mode
    };

    if (settings.mode === "contest") {
      try {
        await API.saveResult(result);
      } catch (err) {
        setStatusMessage("Could not save result. Offline?" );
      }
    }

    localStorage.setItem(settingsKey(settings), JSON.stringify({ accuracy, cpm }));
    setScreen("results");
  };

  const loadMoreTasks = async () => {
    const generated = await API.generateTasks(settings.level, 40, settings.contentMode, settings.language);
    if (generated.fallbackNotice) {
      setStatusMessage(generated.fallbackNotice);
    }
    setTasks((prev) => [...prev, ...generated.tasks]);
  };

  const handleCorrect = () => {
    const duration = Math.max(250, appSettings.correctEffects.durationMs / appSettings.animationSpeed);
    const soundChoice = appSettings.correctEffects.randomizeSound
      ? SOUND_OPTIONS[Math.floor(Math.random() * SOUND_OPTIONS.length)]
      : appSettings.correctEffects.sound;
    sound.play(soundChoice);
    setEffectSeed(appSettings.correctEffects.variation === "same"
      ? 7
      : appSettings.correctEffects.variation === "small"
        ? currentIndex + gameStats.correct + 13
        : Date.now()
    );
    setEffectTick((prev) => prev + 1);
    setShowEffects(true);
    if (appSettings.correctEffects.transformLetter) {
      setCorrectFlash(true);
      setTimeout(() => setCorrectFlash(false), Math.min(500, duration * 0.6));
    }
    setTimeout(() => setShowEffects(false), duration);
    setGameStats((prev) => {
      let streak = prev.streak;
      if (appSettings.streakPolicy === "never") {
        streak = prev.streak + 1;
      } else if (appSettings.streakPolicy === "task_fail") {
        streak = taskHadMistake ? 0 : prev.streak + 1;
      } else {
        streak = prev.streak + 1;
      }
      return {
        ...prev,
        correct: prev.correct + 1,
        tasksCompleted: prev.tasksCompleted + 1,
        streak,
        maxStreak: Math.max(prev.maxStreak, streak)
      };
    });
    setBuffer("");
    setCurrentIndex((prev) => prev + 1);
  };

  const registerMistake = () => {
    const duration = Math.max(250, appSettings.correctEffects.durationMs / appSettings.animationSpeed);
    if (appSettings.mistakeStyle === "normal") {
      sound.play("pop");
    }
    setMistakeFlash(true);
    setTimeout(() => setMistakeFlash(false), Math.min(500, duration * 0.6));
    setTaskHadMistake(true);
    setGameStats((prev) => ({
      ...prev,
      incorrect: prev.incorrect + 1,
      streak: appSettings.streakPolicy === "first_wrong" ? 0 : prev.streak
    }));
  };

  const handleIncorrect = (advanceTask: boolean) => {
    registerMistake();
    setBuffer("");
    if (advanceTask && settings.mode === "contest") {
      setGameStats((prev) => ({
        ...prev,
        tasksCompleted: prev.tasksCompleted + 1
      }));
      setCurrentIndex((prev) => prev + 1);
    }
  };

  const handleKey = useCallback((event: KeyboardEvent) => {
    if (screen !== "game" || !currentTask) return;
    const key = event.key;
    const kind = classifyKey(event);

    if (kind === "function" && appSettings.protectFunctionKeys) {
      const now = Date.now();
      if (lastFunctionKey === key && now - lastFunctionKeyTime < 3000) {
        setFunctionKeyNotice("");
        setLastFunctionKey("");
        setLastFunctionKeyTime(0);
        return;
      }
      event.preventDefault();
      setLastFunctionKey(key);
      setLastFunctionKeyTime(now);
      setFunctionKeyNotice("Function key pressed. Press again to use it.");
      return;
    }

    if (kind === "modifier" || kind === "navigation" || kind === "other") return;

    if (kind === "space") {
      if (!expectSpace) return;
    }

    if (kind === "punct") {
      return;
    }

    if (kind === "space") {
      if (key === " ") {
        setExpectSpace(false);
        handleCorrect();
      }
      return;
    }

    const normalized = key.toLowerCase();
    const expected = currentTask.answer.toLowerCase();
    const expectedChar = expected[caretIndex];

    if (!expectedChar) return;

    if (appSettings.languageReminder && !langDismissed) {
      const expectedIsAlphaNum = /[a-z0-9]/.test(expectedChar);
      const keyIsAsciiAlphaNum = /[a-z0-9]/i.test(key);
      if (expectedIsAlphaNum && kind === "alphaNum" && !keyIsAsciiAlphaNum) {
        const now = Date.now();
        const reset = now - langMismatchTs > 5000;
        const nextCount = reset ? 1 : langMismatchCount + 1;
        setLangMismatchTs(now);
        setLangMismatchCount(nextCount);
        if (nextCount >= 2) setShowLangBanner(true);
      }
    }
    if (showLangBanner) setShowLangBanner(false);

    if (expected.length === 1) {
      if (normalized === expectedChar) {
        handleCorrect();
      } else {
        handleIncorrect(settings.mode === "contest");
      }
      return;
    }

    if (normalized === expectedChar) {
      const nextBuffer = buffer + normalized;
      setBuffer(nextBuffer);
      setProgress((prev) => {
        const next = [...prev];
        next[caretIndex] = "correct";
        return next;
      });
      const nextCaret = caretIndex + 1;
      if (nextCaret >= expected.length) {
        if (currentTask.sentence && appSettings.spaceRequired) {
          setExpectSpace(true);
        } else {
          handleCorrect();
        }
      } else {
        setCaretIndex(nextCaret);
      }
    } else {
      registerMistake();
      setProgress((prev) => {
        const next = [...prev];
        next[caretIndex] = "wrong";
        return next;
      });
      setTimeout(() => {
        setProgress((prev) => {
          const next = [...prev];
          if (next[caretIndex] === "wrong") next[caretIndex] = "pending";
          return next;
        });
      }, 400);
      if (appSettings.wrongCharBehavior === "skip") {
        const nextCaret = caretIndex + 1;
        if (nextCaret >= expected.length) {
          if (currentTask.sentence && appSettings.spaceRequired) {
            setExpectSpace(true);
          } else {
            handleCorrect();
          }
        } else {
          setCaretIndex(nextCaret);
        }
      }
    }
  }, [
    screen,
    currentTask,
    buffer,
    caretIndex,
    expectSpace,
    appSettings.languageReminder,
    appSettings.spaceRequired,
    appSettings.wrongCharBehavior,
    appSettings.protectFunctionKeys,
    langMismatchCount,
    langMismatchTs,
    langDismissed,
    lastFunctionKey,
    lastFunctionKeyTime,
    showLangBanner
  ]);

  useEffect(() => {
    if (screen !== "game") return;
    const interval = setInterval(() => {
      setElapsedMs(Date.now() - startTime);
      if (timeLeft !== null) {
        setTimeLeft((prev) => {
          if (prev === null) return null;
          const next = prev - 200;
          if (next <= 0) {
            endGame();
            return 0;
          }
          return next;
        });
      }
    }, 200);
    return () => clearInterval(interval);
  }, [screen, startTime, timeLeft]);

  useEffect(() => {
    if (screen !== "game") return;
    const listener = (e: KeyboardEvent) => handleKey(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [screen, handleKey]);

  useEffect(() => {
    if (screen !== "game") return;
    if (tasks.length - currentIndex < 10) {
      loadMoreTasks();
    }
    if (settings.mode === "contest" && settings.contestType === "tasks") {
      if (gameStats.tasksCompleted >= settings.taskTarget) {
        endGame();
      }
    }
  }, [screen, currentIndex, tasks.length, gameStats.tasksCompleted, settings]);

  useEffect(() => {
    if (!currentTask) return;
    setCaretIndex(0);
    setBuffer("");
    setProgress(Array.from({ length: currentTask.answer.length }, () => "pending"));
    setExpectSpace(false);
    setTaskHadMistake(false);
  }, [currentTask?.id]);

  useEffect(() => {
    if (!allowedLevels.includes(settings.level)) {
      setSettings((prev) => ({ ...prev, level: allowedLevels[0] }));
    }
  }, [allowedLevels, settings.level]);

  const loadLeaderboard = async (filters: any) => {
    setStatusMessage("");
    try {
      const data = await API.getLeaderboard(filters);
      setLeaderboard(data.entries);
      setMyRank(data.myRank);
    } catch (err) {
      setStatusMessage("Could not load leaderboard.");
    }
  };

  const loadPacks = async () => {
    try {
      const list = await API.getVocabPacks();
      setPacks(list);
    } catch (err) {
      setStatusMessage("Could not load vocab packs.");
    }
  };

  async function signOut() {
    try {
      await API.logout();
    } catch {
      // ignore best-effort logout
    }
    setSessionUser(null);
    setAuthMessage("Signed out.");
  }

  async function submitEmailAuth() {
    if (!authEmail) {
      setAuthMessage("Enter an email address first.");
      return false;
    }
    try {
      if (authMode === "register") {
        if (!authPassword) {
          setAuthMessage("Enter a password.");
          return false;
        }
        const result = await API.registerWithPassword({
          email: authEmail,
          displayName: authDisplayName || authEmail.split("@")[0],
          password: authPassword
        });
        setSessionUser(result.user || null);
        setAuthMessage("Account created and signed in.");
        return true;
      } else if (authMode === "forgot") {
        if (!passwordResetEnabled) {
          setAuthMessage("Password reset email is unavailable. Ask an admin to configure SMTP.");
          return false;
        }
        if (passwordResetToken) {
          if (!passwordResetPassword) {
            setAuthMessage("Enter a new password.");
            return false;
          }
          await API.confirmPasswordReset({ token: passwordResetToken, password: passwordResetPassword });
          const session = await API.getPublicSession();
          setSessionUser(session.actor?.isAuthenticated ? session.actor : null);
          setPasswordResetToken("");
          setPasswordResetPassword("");
          setAuthMode("login");
          setAuthMessage("Password updated.");
          return true;
        } else {
          const data = await API.requestPasswordReset(authEmail);
          setAuthMessage(data?.message || "If the account exists, a reset email was sent.");
          return false;
        }
      } else {
        if (!authPassword) {
          setAuthMessage("Enter your password.");
          return false;
        }
        const result = await API.loginWithPassword({ email: authEmail, password: authPassword });
        setSessionUser(result.user || null);
        setAuthMessage("Signed in.");
        return true;
      }
    } catch (err: any) {
      setAuthMessage(err?.message || "Authentication failed.");
      reportClientError("submit_email_auth", err);
      return false;
    }
  }

  async function handleGoogleCredential(credential: string) {
    try {
      const result = await API.authWithGoogle(credential);
      setSessionUser(result.user || null);
      setAuthMessage("Signed in with Google.");
    } catch (err: any) {
      setAuthMessage(err?.message || "Google sign-in failed.");
      reportClientError("google_sign_in", err);
    }
  }

  const requestFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen();
    }
  };

  useEffect(() => {
    if (screen === "leaderboard") {
      loadLeaderboard({ contestType: "time", level: 1, contentMode: "default" });
    }
    if (screen === "settings") {
      loadPacks();
    }
  }, [screen]);

  useEffect(() => {
    if (isSetupRoute || isSetupRequired) {
      setAvailableLanguages(["en", "ru"]);
      return;
    }
    API.getAvailableLanguages(settings.level)
      .then((data) => {
        const langs = Array.isArray(data.languages) && data.languages.length > 0 ? data.languages : ["en", "ru"];
        setAvailableLanguages(langs);
        if (!langs.includes(settings.language)) {
          setSettings((prev) => ({ ...prev, language: langs[0] }));
        }
      })
      .catch(() => setAvailableLanguages(["en", "ru"]));
  }, [settings.level, isSetupRoute, isSetupRequired]);

  useEffect(() => {
    if (isSetupRoute || isSetupRequired) return;
    const poll = () => {
      API.getLiveStats()
        .then((data) => setLiveStats(data.stats || { total: 0, authorized: 0, guests: 0, modes: [] }))
        .catch((err) => reportClientError("poll_live_stats", err));
    };
    poll();
    const id = window.setInterval(poll, 15000);
    return () => window.clearInterval(id);
  }, [isSetupRoute, isSetupRequired, reportClientError]);

  const path = window.location.pathname;
  const isTextFitDiagnostics = path === "/diagnostics/text-fit";
  const isUxDiagnostics = path === "/diagnostics/ux";
  const isControlsDiagnostics = path === "/diagnostics/controls";

  if (isTextFitDiagnostics) {
    return (
      <div className={`app${theme.flat ? " flat" : ""}`} style={themeVars}>
        <DiagnosticsPage settings={appSettings} />
      </div>
    );
  }
  if (isUxDiagnostics) {
    return (
      <div className={`app${theme.flat ? " flat" : ""}`} style={themeVars}>
        <UXDiagnosticsPage settings={appSettings} contrastReport={contrastReport} />
      </div>
    );
  }
  if (isControlsDiagnostics) {
    return (
      <div className={`app${theme.flat ? " flat" : ""}`} style={themeVars}>
        <ControlsDiagnosticsPage settings={appSettings} setSettings={setAppSettings} />
      </div>
    );
  }

  return (
    <div className={`app${theme.flat ? " flat" : ""}`} style={themeVars}>
      <Modal
        opened={showStopModal}
        onClose={() => {
          setShowStopModal(false);
          setSavePartial(false);
        }}
        title="Stop this session?"
        centered
        overlayProps={{ backgroundOpacity: 0.72, blur: 1 }}
        classNames={{
          overlay: "app-modal-overlay",
          content: "app-modal-content",
          header: "app-modal-header",
          title: "app-modal-title",
          body: "app-modal-body",
          close: "app-modal-close"
        }}
      >
        <Text>
          Your current progress will be lost.
          {settings.mode === "contest" && " You can optionally save a partial result to the leaderboard."}
        </Text>
        {settings.mode === "contest" && (
          <Checkbox
            mt="md"
            label="Save partial to leaderboard"
            checked={savePartial}
            onChange={(e) => setSavePartial(e.currentTarget.checked)}
          />
        )}
        <Group justify="flex-end" mt="lg">
          <Button variant="light" onClick={() => setShowStopModal(false)}>Continue</Button>
          <Button
            color="red"
            onClick={async () => {
              setShowStopModal(false);
              await stopSession(settings.mode === "contest" && savePartial);
              setSavePartial(false);
            }}
          >
            Stop session
          </Button>
        </Group>
      </Modal>
      <Modal
        opened={showUnsavedSettingsModal}
        onClose={() => {
          setShowUnsavedSettingsModal(false);
          setPendingScreen(null);
        }}
        title="Unsaved changes"
        centered
      >
        <Text size="sm">You have unsaved settings changes.</Text>
        <Group justify="flex-end" mt="md">
          <Button
            variant="light"
            onClick={() => {
              setShowUnsavedSettingsModal(false);
              setPendingScreen(null);
            }}
          >
            Cancel
          </Button>
          <Button
            color="red"
            variant="light"
            onClick={() => {
              resetSettingsDraft();
              const next = pendingScreen;
              setShowUnsavedSettingsModal(false);
              setPendingScreen(null);
              if (next) setScreen(next);
            }}
          >
            Discard
          </Button>
          <Button
            onClick={async () => {
              const ok = await applySettings();
              if (!ok) return;
              const next = pendingScreen;
              setShowUnsavedSettingsModal(false);
              setPendingScreen(null);
              if (next) setScreen(next);
            }}
          >
            Apply
          </Button>
        </Group>
      </Modal>
      <Modal
        opened={setupWizardOpen}
        onClose={() => {
          if (setupStatus?.wizardCompleted) setSetupWizardOpen(false);
        }}
        title="Installation Wizard"
        centered
        closeOnClickOutside={Boolean(setupStatus?.wizardCompleted)}
        closeOnEscape={Boolean(setupStatus?.wizardCompleted)}
      >
        <Stack gap="sm">
          <Alert color={publicConfigOverall === "SETUP_REQUIRED" ? "red" : publicConfigOverall === "DEGRADED" ? "yellow" : "green"} title={`Config status: ${publicConfigOverall}`}>
            Setup mode is derived from required configuration health.
          </Alert>
          <Text size="sm">Complete required setup steps to enable full admin functionality.</Text>
          <Text size="sm">1. Database: {setupStatus?.steps?.database?.state || (setupStatus?.steps?.database?.ready ? "READY" : "MISSING")}</Text>
          <Text size="sm">2. Admin user: {setupStatus?.steps?.adminUser?.state || (setupStatus?.steps?.adminUser?.ready ? "READY" : "MISSING")}</Text>
          <Text size="sm">3. SMTP: {setupStatus?.steps?.smtp?.state || (setupStatus?.steps?.smtp?.ready ? "READY" : "MISSING")} (optional)</Text>
          <Text size="sm">4. Google auth: {setupStatus?.steps?.googleAuth?.state || (setupStatus?.steps?.googleAuth?.ready ? "READY" : "MISSING")} (optional)</Text>
          {setupDbStatus && (
            <Alert color={setupDbStatus?.database === "READY" ? "green" : "red"} title="Database status">
              Driver: {setupDbStatus?.activeDriver || "unknown"} | State: {setupDbStatus?.database || "unknown"}
            </Alert>
          )}
          {!setupStatus?.steps?.adminUser?.ready && (
            <Card withBorder>
              <Stack gap="xs">
                <Text fw={600} size="sm">Create initial admin user</Text>
                <TextInput label="Admin email" value={setupAdminEmail} onChange={(e) => setSetupAdminEmail(e.currentTarget.value)} />
                <TextInput label="Display name" value={setupAdminName} onChange={(e) => setSetupAdminName(e.currentTarget.value)} />
                <TextInput
                  label="Password"
                  description="10-128 chars, include at least one letter and one number."
                  type="password"
                  value={setupAdminPassword}
                  onChange={(e) => setSetupAdminPassword(e.currentTarget.value)}
                />
                <Button
                  onClick={async () => {
                    try {
                      await API.setupCreateAdmin({ email: setupAdminEmail, displayName: setupAdminName, password: setupAdminPassword });
                      setSetupMessage("Admin user created.");
                      setSetupAdminPassword("");
                      await refreshSetupStatus();
                    } catch (err: any) {
                      setSetupMessage(err?.message || "Admin setup failed.");
                      reportClientError("setup_create_admin", err);
                    }
                  }}
                >
                  Create admin
                </Button>
              </Stack>
            </Card>
          )}
          {Array.isArray(setupStatus?.details) && setupStatus.details.length > 0 && (
            <Card withBorder>
              <Stack gap="xs">
                <Text fw={600} size="sm">Remediation</Text>
                {setupStatus.details.map((d: any) => (
                  <Text key={String(d.key)} size="xs">
                    [{String(d.severity || "INFO")}] {String(d.message || "")} - {String(d.remediation_hint || "")}
                  </Text>
                ))}
              </Stack>
            </Card>
          )}
          {setupMessage && <Alert color="yellow">{setupMessage}</Alert>}
          <Group justify="space-between">
            <Button variant="light" onClick={() => refreshSetupStatus().catch(() => null)}>Refresh</Button>
            <Group>
              {!setupStatus?.steps?.adminUser?.ready && sessionUser && (
                <Button
                  variant="light"
                  onClick={async () => {
                    try {
                      await API.bootstrapOwner();
                      setSetupMessage("Owner bootstrap complete.");
                      await API.getPublicSession().then((s) => setSessionUser(s.actor?.isAuthenticated ? s.actor : null));
                      await refreshSetupStatus();
                    } catch (err: any) {
                      setSetupMessage(err?.message || "Owner bootstrap failed.");
                      reportClientError("setup_bootstrap_owner", err);
                    }
                  }}
                >
                  Make me owner
                </Button>
              )}
              <Button
                disabled={!isAdminUser || publicConfigOverall === "SETUP_REQUIRED"}
                onClick={async () => {
                  try {
                    await API.completeSetup();
                    setSetupMessage("Setup completed.");
                    await refreshSetupStatus();
                  } catch (err: any) {
                    setSetupMessage(err?.message || "Failed to complete setup.");
                    reportClientError("setup_complete", err);
                  }
                }}
              >
                Complete setup
              </Button>
            </Group>
          </Group>
        </Stack>
      </Modal>
      <Modal opened={errorLogOpen} onClose={() => setErrorLogOpen(false)} title="Error Diagnostics" size="xl" centered>
        <Stack gap="sm">
          <Text size="sm">
            Share this payload when reporting issues. It includes request IDs for backend correlation.
          </Text>
          <Textarea
            minRows={12}
            autosize
            readOnly
            value={JSON.stringify(clientErrors, null, 2)}
          />
          <Group justify="space-between">
            <Button
              variant="light"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(JSON.stringify(clientErrors, null, 2));
                  setStatusMessage("Error diagnostics copied.");
                } catch {
                  setStatusMessage("Failed to copy diagnostics.");
                }
              }}
            >
              Copy diagnostics
            </Button>
            <Button
              color="red"
              variant="light"
              onClick={() => {
                setClientErrors([]);
                setStatusMessage("Error diagnostics cleared.");
              }}
            >
              Clear
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal opened={showAuthModal} onClose={() => setShowAuthModal(false)} title="Sign in" centered>
        <Stack gap="sm">
          <SegmentedControl
            value={authMode}
            onChange={(value) => setAuthMode(value as "login" | "register" | "forgot")}
            data={[
              { value: "login", label: "Email login" },
              { value: "register", label: "Sign up" },
              { value: "forgot", label: "Forgot password" }
            ]}
          />
          <TextInput
            label="Email"
            value={authEmail}
            onChange={(e) => setAuthEmail(e.currentTarget.value)}
            placeholder="you@example.com"
          />
          {authMode === "register" && (
            <TextInput
              label="Display name"
              value={authDisplayName}
              onChange={(e) => setAuthDisplayName(e.currentTarget.value)}
              placeholder="Player"
            />
          )}
          {(authMode === "login" || authMode === "register") && (
            <TextInput
              type="password"
              label="Password"
              value={authPassword}
              onChange={(e) => setAuthPassword(e.currentTarget.value)}
              placeholder="At least 10 characters"
            />
          )}
          {authMode === "forgot" && passwordResetToken && (
            <TextInput
              type="password"
              label="New password"
              value={passwordResetPassword}
              onChange={(e) => setPasswordResetPassword(e.currentTarget.value)}
              placeholder="Enter a new password"
            />
          )}
          <Button
            disabled={authMode === "forgot" && !passwordResetEnabled}
            onClick={async () => {
              const ok = await submitEmailAuth();
              if (ok) setShowAuthModal(false);
            }}
          >
            {authMode === "register"
              ? "Create account"
              : authMode === "forgot"
                ? (passwordResetToken ? "Set new password" : "Send reset email")
                : "Sign in"}
          </Button>
          {authMode === "forgot" && !passwordResetEnabled && (
            <Text size="xs" c="dimmed">Password reset requires SMTP settings from an admin.</Text>
          )}
          {googleClientId && <div id="google-signin-button" />}
          {authMessage && <Text size="xs" c="dimmed">{authMessage}</Text>}
        </Stack>
      </Modal>
      <header className="topbar">
        <UnstyledButton className="brand" onClick={handleBrandClick} aria-label="Go to main menu">K-TRAIN</UnstyledButton>
        <div className="topbar-actions">
          {!isSetupRoute && !isSetupRequired && (
            <Button variant="light" size="xs" onClick={() => { window.history.pushState({}, "", "/about"); setScreen("about"); }}>About</Button>
          )}
          {!isSetupRoute && !isSetupRequired && !sessionUser && (
            <Button variant="light" size="xs" onClick={() => setShowAuthModal(true)}>Log in</Button>
          )}
          {!isSetupRoute && !isSetupRequired && sessionUser && (
            <div className="account-menu-wrap">
              <Button variant="light" size="xs" onClick={() => setAccountMenuOpen((v) => !v)}>
                {sessionUser.displayName || sessionUser.email || "Account"}
              </Button>
              {accountMenuOpen && (
                <Card className="account-menu" withBorder shadow="sm">
                  <Stack gap={6}>
                    <Button size="xs" variant="subtle" onClick={() => { setScreen("settings"); setAccountMenuOpen(false); }}>Account</Button>
                    <Button size="xs" variant="subtle" onClick={() => { setScreen("settings"); setAccountMenuOpen(false); }}>Settings</Button>
                    <Button size="xs" color="red" variant="subtle" onClick={() => { setAccountMenuOpen(false); void signOut(); }}>Log out</Button>
                  </Stack>
                </Card>
              )}
            </div>
          )}
          <Button variant={clientErrors.length > 0 ? "filled" : "light"} size="xs" color={clientErrors.length > 0 ? "red" : undefined} onClick={() => setErrorLogOpen(true)}>
            Errors: {clientErrors.length}
          </Button>
          <Button
            variant="light"
            size="xs"
            onClick={() => setAppSettings((prev) => ({ ...prev, soundEnabled: !prev.soundEnabled }))}
          >
            Sound: {appSettings.soundEnabled ? "ON" : "OFF"}
          </Button>
          <Button variant="light" size="xs" onClick={requestFullscreen}>Fullscreen</Button>
        </div>
      </header>
      {appMode === "advanced-debug" && (
        <Alert color="orange" title="ADVANCED DEBUG ACTIVE">
          Advanced debug mode is enabled and should be temporary.
        </Alert>
      )}

      {screen === "about" && (
        <div className="screen home">
          <Title order={1}>About K-TRAIN</Title>
          <Card className="form-card" shadow="sm" radius="lg" withBorder>
            <Stack gap="sm">
              <Text>K-TRAIN is a typing game for toddlers through adults, from first letters to timed challenges.</Text>
              <Text size="sm">Current modes: Learning and Contest. Experimental modes are planned and may appear behind admin controls.</Text>
              <Text size="sm">Global leaderboard ranks authorized players by score, speed, and accuracy.</Text>
              <Text size="sm">Privacy and safety: kid-safe default content, no public email exposure, and admin-governed service settings.</Text>
              <Group>
                <Button variant="light" onClick={() => { window.history.pushState({}, "", "/"); setScreen("home"); }}>Back to game</Button>
                <Button variant="light" onClick={() => setScreen("settings")}>Settings / Admin</Button>
              </Group>
            </Stack>
          </Card>
        </div>
      )}

      {screen === "home" && (
        <div className="screen home">
          <Title order={1}>Keyboard Trainer</Title>
          <Text>Big keys. Big wins.</Text>
          <Card className="form-card" shadow="sm" radius="lg" withBorder>
            <Stack gap="md">
              {sessionUser ? (
                <Card withBorder radius="md" p="sm">
                  <Text fw={600}>Playing as: {sessionUser.displayName || sessionUser.email || "Player"}</Text>
                </Card>
              ) : (
                <TextInput
                  label="Guest nickname"
                  value={settings.playerName}
                  onChange={(e) => setSettings({ ...settings, playerName: e.target.value })}
                  placeholder="Guest"
                />
              )}
              <Stack gap="xs">
                <Text fw={600}>Mode</Text>
                <SegmentedControl
                  value={settings.mode}
                  onChange={(value) => setSettings({ ...settings, mode: value as Mode })}
                  data={[
                    { value: "learning", label: "Learning" },
                    { value: "contest", label: "Contest" }
                  ]}
                />
              </Stack>
              <Stack gap="xs">
                <Text fw={600}>Level</Text>
                <SegmentedControl
                  value={String(settings.level)}
                  onChange={(value) => setSettings({ ...settings, level: Number(value) })}
                  data={allowedLevels.map((lvl) => ({
                    value: String(lvl),
                    label: String(lvl)
                  }))}
                />
              </Stack>
              {settings.mode === "contest" && (
                <Stack gap="xs">
                  <Text fw={600}>Contest type</Text>
                  <SegmentedControl
                    value={settings.contestType}
                    onChange={(value) => setSettings({ ...settings, contestType: value as ContestType })}
                    data={[
                      { value: "time", label: "Time" },
                      { value: "tasks", label: "Tasks" }
                    ]}
                  />
                </Stack>
              )}
              {settings.mode === "contest" && settings.contestType === "time" && (
                <Stack gap="xs">
                  <Text fw={600}>Duration</Text>
                  <SegmentedControl
                    value={String(settings.duration)}
                    onChange={(value) => setSettings({ ...settings, duration: Number(value) as 30 | 60 | 120 })}
                    data={[
                      { value: "30", label: "30s" },
                      { value: "60", label: "60s" },
                      { value: "120", label: "120s" }
                    ]}
                  />
                </Stack>
              )}
              {settings.mode === "contest" && settings.contestType === "tasks" && (
                <Stack gap="xs">
                  <Text fw={600}>Tasks</Text>
                  <SegmentedControl
                    value={String(settings.taskTarget)}
                    onChange={(value) => setSettings({ ...settings, taskTarget: Number(value) as 10 | 20 | 50 })}
                    data={[
                      { value: "10", label: "10" },
                      { value: "20", label: "20" },
                      { value: "50", label: "50" }
                    ]}
                  />
                </Stack>
              )}
              <Stack gap="xs">
                <Text fw={600}>Content</Text>
                <SegmentedControl
                  value={settings.contentMode}
                  onChange={(value) => setSettings({ ...settings, contentMode: value as ContentMode })}
                  data={[
                    { value: "default", label: "Default" },
                    { value: "vocab", label: "Vocab Pack" }
                  ]}
                />
              </Stack>
              <Stack gap="xs">
                <Text fw={600}>Language</Text>
                <Select
                  data={availableLanguages.map((lang) => ({ value: lang, label: lang.toUpperCase() }))}
                  value={settings.language}
                  onChange={(value) => setSettings({ ...settings, language: value || "en" })}
                />
              </Stack>
              <Card withBorder radius="md" p="sm">
                <Text fw={600}>Live Activity</Text>
                <Text size="sm">Users playing now: {liveStats.total}</Text>
                <Text size="xs" c="dimmed">Authorized: {liveStats.authorized} • Guests: {liveStats.guests}</Text>
              </Card>
              <Button size="lg" onClick={startGame}>Start</Button>
            </Stack>
          </Card>
          <Group>
            <Button variant="light" onClick={() => setScreen("leaderboard")}>Leaderboard</Button>
            <Button variant="light" onClick={() => setScreen("settings")}>Settings / Admin</Button>
          </Group>
        </div>
      )}

      {screen === "game" && currentTask && (
        <div className={"screen game " + (mistakeFlash ? "mistake" : "") }>
          <div className="game-layout">
            <StatsBar
              cpm={cpm}
              accuracy={accuracy}
              incorrectRatio={incorrectRatio}
              tasksCompleted={gameStats.tasksCompleted}
              streak={gameStats.streak}
              stars={stars}
              trendLabel={trendLabel}
              timer={settings.mode === "contest" && settings.contestType === "time" ? Math.ceil((timeLeft ?? 0) / 1000) : null}
            />

            <TaskStage
              currentTask={currentTask}
              fitConfigCurrent={fitConfigCurrent}
              fitConfigSentence={fitConfigSentence}
              appSettings={appSettings}
              correctFlash={correctFlash}
              mistakeFlash={mistakeFlash}
              buffer={buffer}
              progress={progress}
              caretIndex={caretIndex}
              expectSpace={expectSpace}
              fitMetrics={currentFit}
              onMetrics={setCurrentFit}
            />

            {appSettings.languageReminder && (
              <LanguageBanner
                show={showLangBanner && !langDismissed}
                onDismiss={() => setLangDismissed(true)}
              />
            )}
            {functionKeyNotice && (
              <FunctionKeyBanner message={functionKeyNotice} onDismiss={() => setFunctionKeyNotice("")} />
            )}
            {settings.mode === "learning"
              && showZeroHint
              && appSettings.differentiateZero
              && /[0O]/.test(currentTask.prompt) && (
                <ZeroHintBanner
                  onDismiss={() => {
                    setShowZeroHint(false);
                    localStorage.setItem("zero_hint_shown", "1");
                  }}
                />
              )}

            <CarriageBar
              prevTask={prevTask}
              nextTask={nextTask}
              compactUI={compactUI}
              fitConfigSecondary={fitConfigSecondary}
              appSettings={appSettings}
              setAppSettings={setAppSettings}
              onEnd={endGame}
            />
          </div>

          {appSettings.debugLayout && currentFit && (
            <DebugOverlay metrics={currentFit} scale={textScale} />
          )}

          <CorrectEffects
            show={showEffects}
            tick={effectTick}
            seed={effectSeed}
            settings={appSettings}
            intensity={intensity}
          />
        </div>
      )}

      {screen === "results" && (
        <div className="screen results">
          <h2>Great Job!</h2>
          <div className="card">
            <div className="result-grid">
              <div>Score</div><div>{score}</div>
              <div>Accuracy</div><div>{accuracy}%</div>
              <div>CPM</div><div>{cpm}</div>
              <div>Extra tries</div><div>{gameStats.incorrect}</div>
              <div>Tasks Completed</div><div>{gameStats.tasksCompleted}</div>
              <div>Max Streak</div><div>{gameStats.maxStreak}</div>
            </div>
          </div>
          {statusMessage && <div className="status">{statusMessage}</div>}
          <Group className="actions">
            <Button onClick={() => navigateFromSettings("home")}>Home</Button>
            <Button variant="light" onClick={() => navigateFromSettings("leaderboard")}>Leaderboard</Button>
          </Group>
        </div>
      )}

      {screen === "leaderboard" && (
        <LeaderboardScreen
          onBack={() => navigateFromSettings("home")}
          onLoad={loadLeaderboard}
          entries={leaderboard}
          myRank={myRank}
          statusMessage={statusMessage}
        />
      )}

      {screen === "settings" && (
        <SettingsScreen
          isAdmin={isAdminUser}
          appSettings={appSettings}
          setAppSettings={setAppSettings}
          contrastReport={contrastReport}
          levelConverted={levelConverted}
          onApplyVisibilityFix={() => {
            setAppSettings((prev) => ({
              ...prev,
              theme: "custom",
              customTheme: {
                ...prev.customTheme,
                background: theme.background,
                backgroundAlt: theme.backgroundAlt,
                panel: theme.surface || theme.panel,
                text: theme.text,
                mutedText: theme.mutedText,
                accent: theme.accent,
                highlight: theme.highlight,
                correct: theme.correct,
                mistake: theme.mistake
              }
            }));
          }}
          adminPin={adminPin}
          setAdminPin={setAdminPin}
          packs={packs}
          onBack={() => navigateFromSettings("home")}
          onApplySettings={applySettings}
          onResetSettingsDraft={resetSettingsDraft}
          hasUnsavedSettings={hasUnsavedSettings}
          lastSettingsAppliedAt={lastSettingsAppliedAt}
          publicVersion={publicVersion}
          sessionUser={sessionUser}
          selectedLanguage={settings.language}
          onReloadPacks={loadPacks}
          onReset={async (scope) => {
            try {
              await API.adminReset(scope, adminPin);
              setStatusMessage("Reset complete.");
            } catch {
              setStatusMessage("Reset failed.");
            }
          }}
          onSeed={async () => {
            try {
              await API.adminSeedDefaults(adminPin);
              setStatusMessage("Defaults seeded.");
              loadPacks();
            } catch {
              setStatusMessage("Seed failed.");
            }
          }}
          onDeletePack={async (id) => {
            await API.deleteVocabPack(id, adminPin);
            loadPacks();
          }}
          onActivatePack={async (id) => {
            await API.activateVocabPack(id, adminPin);
            loadPacks();
          }}
          onUpdatePack={async (id, payload) => {
            await API.updateVocabPack(id, payload, adminPin);
            loadPacks();
          }}
          onGenerate={async (payload) => {
            const result = await API.generateVocab(payload, adminPin);
            loadPacks();
            return result;
          }}
          onTestKey={async (payload) => API.testOpenAI(payload, adminPin)}
          statusMessage={statusMessage}
        />
      )}
    </div>
  );
}

function LeaderboardScreen({
  onBack,
  onLoad,
  entries,
  myRank,
  statusMessage
}: {
  onBack: () => void;
  onLoad: (filters: any) => void;
  entries: LeaderboardEntry[];
  myRank: number | null;
  statusMessage: string;
}) {
  const [filters, setFilters] = useState({
    contestType: "time",
    level: 1,
    contentMode: "default",
    duration: "60",
    taskTarget: "20"
  });

  useEffect(() => {
    onLoad(filters);
  }, []);

  const handleFilter = (key: string, value: string | number) => {
    const next = { ...filters, [key]: value };
    setFilters(next);
    onLoad(next);
  };

  return (
    <div className="screen leaderboard">
      <h2>Leaderboard</h2>
      {typeof myRank === "number" && <Text size="sm">My rank: #{myRank}</Text>}
      <div className="card">
        <div className="filters">
          <Select
            label="Contest"
            value={filters.contestType}
            onChange={(value) => handleFilter("contestType", value || "time")}
            data={[
              { value: "time", label: "Time" },
              { value: "tasks", label: "Tasks" }
            ]}
          />
          <Select
            label="Level"
            value={String(filters.level)}
            onChange={(value) => handleFilter("level", Number(value || 1))}
            data={[1, 2, 3, 4, 5].map((lvl) => ({ value: String(lvl), label: String(lvl) }))}
          />
          <Select
            label="Content"
            value={filters.contentMode}
            onChange={(value) => handleFilter("contentMode", value || "default")}
            data={[
              { value: "default", label: "Default" },
              { value: "vocab", label: "Vocab Pack" }
            ]}
          />
          {filters.contestType === "time" ? (
            <Select
              label="Duration"
              value={String(filters.duration)}
              onChange={(value) => handleFilter("duration", value || "60")}
              data={[
                { value: "30", label: "30" },
                { value: "60", label: "60" },
                { value: "120", label: "120" }
              ]}
            />
          ) : (
            <Select
              label="Tasks"
              value={String(filters.taskTarget)}
              onChange={(value) => handleFilter("taskTarget", value || "20")}
              data={[
                { value: "10", label: "10" },
                { value: "20", label: "20" },
                { value: "50", label: "50" }
              ]}
            />
          )}
        </div>
        <div className="leaderboard-table">
          <div className="row header">
            <div>Rank</div>
            <div>Name</div>
            <div>Score</div>
            <div>Accuracy</div>
            <div>CPM</div>
            <div>Streak</div>
          </div>
          {entries.map((entry, idx) => (
            <div className="row" key={entry.id}>
              <div>#{idx + 1}</div>
              <div>{entry.playerName}</div>
              <div>{entry.score}</div>
              <div>{Math.round(entry.accuracy)}%</div>
              <div>{entry.cpm}</div>
              <div>{entry.maxStreak}</div>
            </div>
          ))}
        </div>
      </div>
      {statusMessage && <div className="status">{statusMessage}</div>}
      <Button variant="light" onClick={onBack}>Back</Button>
    </div>
  );
}

function SettingsSection({
  id,
  title,
  description,
  children
}: {
  id: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="settings-section">
      <Card className="settings-card" shadow="sm" radius="lg" withBorder>
        <div className="section-header">
          <div>
            <Title order={3}>{title}</Title>
            <Text size="sm" c="dimmed">{description}</Text>
          </div>
        </div>
        <div className="section-body">
          {children}
        </div>
      </Card>
    </section>
  );
}

const SETTINGS_HELP: Record<string, string> = {
  "Max level (up to)": "Higher levels introduce longer strings and faster complexity. Start lower for young learners.",
  "Visibility Guard": "Automatically adjusts risky color combinations for readability. AAA is the safest default.",
  "Language": "Only published language packs are available for selection at start.",
  "OpenAI API key": "Used only for pack generation and stored encrypted on the server.",
  "SMTP enabled": "Email features stay disabled until SMTP credentials are valid and tested.",
  "Google auth enabled": "Google sign-in can only be enabled after a valid OAuth client is configured.",
  "Postgres connection string": "Optional shortcut for Postgres connectivity. If set, host/user fields are ignored.",
  "Debug layout overlay": "Shows fit diagnostics while playing to speed up UI troubleshooting."
};

function SettingRow({
  label,
  helper,
  hint,
  children,
  full
}: {
  label: string;
  helper?: string;
  hint?: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  const resolvedHint = hint || SETTINGS_HELP[label];
  return (
    <div className={`setting-row${full ? " full" : ""}`}>
      <div className="setting-label">
        <Group gap={6} align="center">
          <Text fw={600}>{label}</Text>
          {resolvedHint && (
            <Tooltip label={resolvedHint} withArrow>
              <button type="button" className="setting-help" aria-label={`Help for ${label}`}>i</button>
            </Tooltip>
          )}
        </Group>
        {helper && <Text size="sm" c="dimmed">{helper}</Text>}
      </div>
      <div className="setting-control">
        {children}
      </div>
    </div>
  );
}

function SettingSliderRow({
  label,
  helper,
  value,
  min,
  max,
  step,
  onChange,
  formatValue
}: {
  label: string;
  helper?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  formatValue: (value: number) => string;
}) {
  return (
    <SettingRow label={label} helper={helper}>
      <div className="setting-slider-row">
        <div className="setting-slider-control">
          <Slider
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(next) => onChange(Number(next))}
            label={null}
          />
        </div>
        <div className="setting-slider-value">{formatValue(value)}</div>
      </div>
    </SettingRow>
  );
}

function SettingsScreen({
  isAdmin,
  appSettings,
  setAppSettings,
  contrastReport,
  levelConverted,
  onApplyVisibilityFix,
  adminPin,
  setAdminPin,
  packs,
  onBack,
  onReloadPacks,
  onReset,
  onSeed,
  onDeletePack,
  onActivatePack,
  onUpdatePack,
  onGenerate,
  onTestKey,
  statusMessage,
  onApplySettings,
  onResetSettingsDraft,
  hasUnsavedSettings,
  lastSettingsAppliedAt,
  publicVersion,
  sessionUser,
  selectedLanguage
}: {
  isAdmin: boolean;
  appSettings: AppSettings;
  setAppSettings: (value: AppSettings | ((prev: AppSettings) => AppSettings)) => void;
  contrastReport: any;
  levelConverted: boolean;
  onApplyVisibilityFix: () => void;
  adminPin: string;
  setAdminPin: (value: string) => void;
  packs: VocabPack[];
  onBack: () => void;
  onReloadPacks: () => void;
  onReset: (scope: string) => void;
  onSeed: () => void;
  onDeletePack: (id: number) => void;
  onActivatePack: (id: number) => void;
  onUpdatePack: (id: number, payload: any) => void;
  onGenerate: (payload: any) => Promise<any>;
  onTestKey: (payload: any) => Promise<any>;
  statusMessage: string;
  onApplySettings: () => Promise<boolean>;
  onResetSettingsDraft: () => void;
  hasUnsavedSettings: boolean;
  lastSettingsAppliedAt: string;
  publicVersion: PublicVersion | null;
  sessionUser: any;
  selectedLanguage: string;
}) {
  const [openaiKey, setOpenaiKey] = useState("");
  const [storeKey, setStoreKey] = useState(false);
  const [generateType, setGenerateType] = useState<"level2" | "level3" | "sentence_words">("level2");
  const [generateCount, setGenerateCount] = useState(30);
  const [generateName, setGenerateName] = useState("New Pack");
  const [manualEdit, setManualEdit] = useState<Record<number, string>>({});
  const [openaiStatus, setOpenaiStatus] = useState("");
  const [packJson, setPackJson] = useState("");
  const [dbStatus, setDbStatus] = useState<DbAdminStatus | null>(null);
  const [dbConfig, setDbConfig] = useState<DbAdminConfig>({
    sqlitePath: "/data/ktrain.sqlite",
    postgres: {
      host: "ktrain_postgres",
      port: 5432,
      database: "ktrain",
      user: "ktrain",
      password: "",
      connectionString: ""
    }
  });
  const [dbMessage, setDbMessage] = useState("");
  const [dbBusy, setDbBusy] = useState(false);
  const [emailSettings, setEmailSettings] = useState({
    enabled: false,
    host: "",
    port: 587,
    secure: false,
    username: "",
    password: "",
    fromAddress: "",
    fromName: "KTrain",
    hasPassword: false
  });
  const [emailTestTo, setEmailTestTo] = useState("");
  const [emailMessage, setEmailMessage] = useState("");
  const [savedEmailSettings, setSavedEmailSettings] = useState<any | null>(null);
  const [googleSettings, setGoogleSettings] = useState({
    enabled: false,
    clientId: "",
    clientSecret: "",
    hasClientSecret: false
  });
  const [googleMessage, setGoogleMessage] = useState("");
  const [savedGoogleSettings, setSavedGoogleSettings] = useState<any | null>(null);
  const [savedDbConfig, setSavedDbConfig] = useState<DbAdminConfig | null>(null);
  const [pinStatus, setPinStatus] = useState<{ pinIsDefault: boolean; source: string } | null>(null);
  const [newAdminPin, setNewAdminPin] = useState("");
  const [confirmAdminPin, setConfirmAdminPin] = useState("");
  const [pinBusy, setPinBusy] = useState(false);
  const [pinMessage, setPinMessage] = useState("");
  const [crashEvents, setCrashEvents] = useState<CrashEvent[]>([]);
  const [crashUnresolvedCount, setCrashUnresolvedCount] = useState(0);
  const [selectedCrash, setSelectedCrash] = useState<CrashEvent | null>(null);
  const [crashBusy, setCrashBusy] = useState(false);
  const [crashMessage, setCrashMessage] = useState("");
  const [languagePackModalOpen, setLanguagePackModalOpen] = useState(false);
  const [configStatus, setConfigStatus] = useState<ConfigStatus | null>(null);
  const [configStatusMessage, setConfigStatusMessage] = useState("");
  const [openaiConfigured, setOpenaiConfigured] = useState(false);
  const [openaiDirty, setOpenaiDirty] = useState(false);
  const [profileDisplayName, setProfileDisplayName] = useState("");
  const [profileNameStatus, setProfileNameStatus] = useState("");
  const [profileNameAvailable, setProfileNameAvailable] = useState(true);
  const [profileCurrentPassword, setProfileCurrentPassword] = useState("");
  const [profileNewPassword, setProfileNewPassword] = useState("");
  const [profileConfirmPassword, setProfileConfirmPassword] = useState("");
  const [profileMessage, setProfileMessage] = useState("");
  const normalizeEmailDraft = (value: any) => ({
    enabled: Boolean(value?.enabled),
    host: String(value?.host || ""),
    port: Number(value?.port || 587),
    secure: Boolean(value?.secure),
    username: String(value?.username || ""),
    fromAddress: String(value?.fromAddress || ""),
    fromName: String(value?.fromName || "KTrain"),
    hasPassword: Boolean(value?.hasPassword)
  });
  const normalizeGoogleDraft = (value: any) => ({
    enabled: Boolean(value?.enabled),
    clientId: String(value?.clientId || ""),
    hasClientSecret: Boolean(value?.hasClientSecret)
  });
  const emailDirty = Boolean(
    savedEmailSettings
      && (
        JSON.stringify(normalizeEmailDraft(emailSettings)) !== JSON.stringify(normalizeEmailDraft(savedEmailSettings))
        || Boolean(String(emailSettings.password || "").trim())
      )
  );
  const googleDirty = Boolean(
    savedGoogleSettings
      && (
        JSON.stringify(normalizeGoogleDraft(googleSettings)) !== JSON.stringify(normalizeGoogleDraft(savedGoogleSettings))
        || Boolean(String(googleSettings.clientSecret || "").trim())
      )
  );
  const dbDirty = Boolean(savedDbConfig && JSON.stringify(dbConfig) !== JSON.stringify(savedDbConfig));
  const hasAnyUnsaved = hasUnsavedSettings || openaiDirty || emailDirty || googleDirty || dbDirty;
  const openaiGenerationReady = isAdmin && openaiConfigured && !openaiDirty;
  const smtpToggleLocked = Boolean(configStatus && configStatus.optional.smtp !== "READY");
  const googleToggleLocked = Boolean(configStatus && configStatus.optional.googleAuth !== "READY");
  const themePreview = applyVisibilityGuard(computeTheme(appSettings), appSettings.visibilityGuard).theme;

  const refreshConfigStatus = async () => {
    if (!adminPin) {
      setConfigStatus(null);
      return;
    }
    try {
      const data = await API.getAdminConfigStatus();
      setConfigStatus((data?.status || null) as ConfigStatus | null);
      setConfigStatusMessage("");
    } catch (err: any) {
      setConfigStatusMessage(err?.message || "Failed to load config status.");
    }
  };

  const applyAllSettings = async () => {
    let ok = true;
    if (hasUnsavedSettings) {
      ok = await onApplySettings();
    }
    if (!ok) return false;
    if (isAdmin && adminPin && dbDirty) {
      try {
        await API.saveDbConfig(adminPin, dbConfig, true);
        setSavedDbConfig(dbConfig);
        setDbMessage("DB config saved and verified.");
      } catch (err: any) {
        setDbMessage(err?.message || "Failed to save DB config");
        return false;
      }
    }
    if (isAdmin && adminPin && emailDirty) {
      try {
        await API.saveEmailSettings(emailSettings);
        const nextEmail = {
          ...emailSettings,
          password: "",
          hasPassword: emailSettings.hasPassword || Boolean(String(emailSettings.password || "").trim())
        };
        setEmailSettings(nextEmail);
        setSavedEmailSettings(nextEmail);
        setEmailMessage("Email settings saved.");
      } catch (err: any) {
        setEmailMessage(err?.message || "Failed to save email settings.");
        return false;
      }
    }
    if (isAdmin && adminPin && googleDirty) {
      try {
        await API.saveGoogleAuthSettings({
          enabled: Boolean(googleSettings.enabled),
          clientId: String(googleSettings.clientId || "").trim(),
          clientSecret: String(googleSettings.clientSecret || "").trim() || undefined
        });
        const nextGoogle = {
          ...googleSettings,
          clientId: String(googleSettings.clientId || "").trim(),
          clientSecret: "",
          hasClientSecret: googleSettings.hasClientSecret || Boolean(String(googleSettings.clientSecret || "").trim())
        };
        setGoogleSettings(nextGoogle);
        setSavedGoogleSettings(nextGoogle);
        setGoogleMessage("Google auth settings saved.");
      } catch (err: any) {
        setGoogleMessage(err?.message || "Failed to save Google auth settings.");
        return false;
      }
    }
    if (openaiDirty) {
      try {
        await API.saveOwnOpenAIKey(openaiKey.trim());
        setOpenaiConfigured(true);
        setOpenaiDirty(false);
        setOpenaiStatus("OpenAI key saved.");
      } catch (err: any) {
        setOpenaiStatus(err?.message || "Failed to save OpenAI key.");
        return false;
      }
    }
    await refreshConfigStatus();
    return true;
  };

  const refreshDb = async () => {
    if (!adminPin) {
      setDbMessage("Sign in with an admin account first.");
      return;
    }
    setDbBusy(true);
    setDbMessage("");
    try {
      const [status, configRes] = await Promise.all([
        API.getDbStatus(adminPin),
        API.getDbConfig(adminPin)
      ]);
      API.getServiceSettings().then((service) => {
        const email = service?.settings?.email || {};
        const google = service?.settings?.auth?.google || {};
        const nextEmail = { ...emailSettings, ...email, password: "" };
        const nextGoogle = { ...googleSettings, ...google, clientSecret: "" };
        setEmailSettings(nextEmail);
        setSavedEmailSettings(nextEmail);
        setGoogleSettings(nextGoogle);
        setSavedGoogleSettings(nextGoogle);
      }).catch(() => null);
      setDbStatus(status);
      setDbConfig(configRes.dbConfig);
      setSavedDbConfig(configRes.dbConfig);
      setDbMessage(`DB status loaded. Active: ${status.activeDriver}`);
      await refreshConfigStatus();
    } catch (err: any) {
      setDbMessage(err?.message || "Failed to load DB status");
    } finally {
      setDbBusy(false);
    }
  };

  const refreshCrashes = async () => {
    if (!adminPin) return;
    setCrashBusy(true);
    setCrashMessage("");
    try {
      const data = await API.listCrashEvents(100, false);
      const list = Array.isArray(data?.crashes) ? data.crashes : [];
      setCrashEvents(list);
      setCrashUnresolvedCount(Number(data?.unresolvedCount || 0));
      if (list.length > 0 && !selectedCrash) setSelectedCrash(list[0]);
    } catch (err: any) {
      setCrashMessage(err?.message || "Failed to load crash events.");
    } finally {
      setCrashBusy(false);
    }
  };

  const acknowledgeCrash = async (id: number) => {
    if (!adminPin) return;
    setCrashBusy(true);
    setCrashMessage("");
    try {
      await API.acknowledgeCrashEvent(id);
      await refreshCrashes();
      setCrashMessage("Crash acknowledged.");
    } catch (err: any) {
      setCrashMessage(err?.message || "Failed to acknowledge crash.");
    } finally {
      setCrashBusy(false);
    }
  };

  const refreshPinStatus = async () => {
    if (!adminPin) {
      setPinStatus(null);
      return;
    }
    try {
      const status = await API.getAdminPinStatus(adminPin);
      setPinStatus(status);
    } catch {
      setPinStatus(null);
    }
  };

  const rotateAdminPin = async () => {
    if (!adminPin) {
      setPinMessage("Admin PIN is removed. Use admin account authorization.");
      return;
    }
    if (newAdminPin.length < 6) {
      setPinMessage("New PIN must be at least 6 characters.");
      return;
    }
    if (newAdminPin !== confirmAdminPin) {
      setPinMessage("New PIN confirmation does not match.");
      return;
    }
    setPinBusy(true);
    setPinMessage("");
    try {
      await API.changeAdminPin(adminPin, adminPin, newAdminPin);
      setAdminPin(newAdminPin);
      setNewAdminPin("");
      setConfirmAdminPin("");
      setPinMessage("Admin PIN is removed. Use admin account authorization.");
      await refreshPinStatus();
    } catch (err: any) {
      setPinMessage(err?.message || "Admin authorization update failed.");
    } finally {
      setPinBusy(false);
    }
  };

  const saveDbConfig = async () => {
    if (!adminPin) {
      setDbMessage("Sign in with an admin account first.");
      return;
    }
    setDbBusy(true);
    setDbMessage("");
    try {
      await API.saveDbConfig(adminPin, dbConfig, true);
      setSavedDbConfig(dbConfig);
      setDbMessage("DB config saved and verified.");
      await refreshDb();
    } catch (err: any) {
      setDbMessage(err?.message || "Failed to save DB config");
    } finally {
      setDbBusy(false);
    }
  };

  const switchDb = async (target: "sqlite" | "postgres") => {
    if (!adminPin) {
      setDbMessage("Sign in with an admin account first.");
      return;
    }
    setDbBusy(true);
    setDbMessage("");
    try {
      const result = await API.switchDb(adminPin, target);
      setDbMessage(`Switched to ${result.targetDriver || target}.`);
      await refreshDb();
    } catch (err: any) {
      setDbMessage(err?.message || "DB switch failed");
    } finally {
      setDbBusy(false);
    }
  };

  const rollbackDb = async () => {
    if (!adminPin) {
      setDbMessage("Sign in with an admin account first.");
      return;
    }
    setDbBusy(true);
    setDbMessage("");
    try {
      const result = await API.rollbackDb(adminPin);
      setDbMessage(`Rollback complete. Active: ${result.activeDriver}`);
      await refreshDb();
    } catch (err: any) {
      setDbMessage(err?.message || "DB rollback failed");
    } finally {
      setDbBusy(false);
    }
  };

  const testPostgresConnection = async () => {
    if (!adminPin) {
      setDbMessage("Sign in with an admin account first.");
      return;
    }
    setDbBusy(true);
    setDbMessage("");
    try {
      await API.testDbConnection(adminPin, { postgres: dbConfig.postgres });
      setDbMessage("Postgres connection successful.");
    } catch (err: any) {
      setDbMessage(err?.message || "Postgres connection failed");
    } finally {
      setDbBusy(false);
    }
  };

  const saveEmailServiceSettings = async () => {
    if (!adminPin) {
      setEmailMessage("Sign in with an admin account first.");
      return;
    }
    try {
      await API.saveEmailSettings(emailSettings);
      const nextEmail = { ...emailSettings, password: "", hasPassword: emailSettings.hasPassword || Boolean(String(emailSettings.password || "").trim()) };
      setEmailSettings(nextEmail);
      setSavedEmailSettings(nextEmail);
      setEmailMessage("Email settings saved.");
      await refreshConfigStatus();
    } catch (err: any) {
      setEmailMessage(err?.message || "Failed to save email settings.");
    }
  };

  const sendEmailTest = async () => {
    if (!adminPin) {
      setEmailMessage("Sign in with an admin account first.");
      return;
    }
    try {
      await API.testSmtpConfig({ to: emailTestTo || "admin@example.com" });
      setEmailMessage("Test email sent.");
      await refreshConfigStatus();
    } catch (err: any) {
      setEmailMessage(err?.message || "Failed to send test email.");
    }
  };

  const saveGoogleSettings = async () => {
    if (!adminPin) {
      setGoogleMessage("Sign in with an admin account first.");
      return;
    }
    try {
      await API.saveGoogleAuthSettings({
        enabled: Boolean(googleSettings.enabled),
        clientId: String(googleSettings.clientId || "").trim(),
        clientSecret: String(googleSettings.clientSecret || "").trim() || undefined
      });
      setGoogleMessage("Google auth settings saved.");
      const nextGoogle = {
        ...googleSettings,
        clientId: String(googleSettings.clientId || "").trim(),
        clientSecret: "",
        hasClientSecret: googleSettings.hasClientSecret || Boolean(String(googleSettings.clientSecret || "").trim())
      };
      setGoogleSettings(nextGoogle);
      setSavedGoogleSettings(nextGoogle);
      await refreshConfigStatus();
    } catch (err: any) {
      setGoogleMessage(err?.message || "Failed to save Google auth settings.");
    }
  };

  useEffect(() => {
    if (!adminPin) return;
    refreshPinStatus().catch(() => null);
    refreshCrashes().catch(() => null);
    refreshConfigStatus().catch(() => null);
    API.getServiceSettings()
      .then((service) => {
        const email = service?.settings?.email || {};
        const google = service?.settings?.auth?.google || {};
        const nextEmail = { ...emailSettings, ...email, password: "" };
        const nextGoogle = { ...googleSettings, ...google, clientSecret: "" };
        setEmailSettings(nextEmail);
        setSavedEmailSettings(nextEmail);
        setGoogleSettings(nextGoogle);
        setSavedGoogleSettings(nextGoogle);
      })
      .catch(() => null);
    API.getDbConfig(adminPin)
      .then((configRes) => {
        setDbConfig(configRes.dbConfig);
        setSavedDbConfig(configRes.dbConfig);
      })
      .catch(() => null);
    API.getOwnOpenAIKeyStatus()
      .then((data) => {
        setOpenaiConfigured(Boolean(data?.configured));
        setOpenaiDirty(false);
      })
      .catch(() => {
        setOpenaiConfigured(false);
      });
  }, [adminPin]);

  useEffect(() => {
    if (!sessionUser) {
      setProfileDisplayName("");
      return;
    }
    API.getUserProfile()
      .then((data) => {
        const display = String(data?.profile?.displayName || sessionUser.displayName || "");
        setProfileDisplayName(display);
        setProfileNameAvailable(true);
        setProfileNameStatus("");
      })
      .catch(() => null);
  }, [sessionUser]);

  useEffect(() => {
    if (!sessionUser) return;
    const trimmed = profileDisplayName.trim();
    if (!trimmed) {
      setProfileNameAvailable(false);
      setProfileNameStatus("Display name is required.");
      return;
    }
    const id = window.setTimeout(() => {
      API.checkDisplayNameAvailability(trimmed)
        .then((data) => {
          const available = Boolean(data?.available);
          setProfileNameAvailable(available);
          setProfileNameStatus(available ? "Display name is available." : "Display name is already taken.");
        })
        .catch(() => {
          setProfileNameAvailable(true);
          setProfileNameStatus("");
        });
    }, 350);
    return () => window.clearTimeout(id);
  }, [profileDisplayName, sessionUser]);

  useEffect(() => {
    if (configStatus?.optional?.smtp && configStatus.optional.smtp !== "READY") {
      setEmailSettings((prev) => ({ ...prev, enabled: false }));
    }
    if (configStatus?.optional?.googleAuth && configStatus.optional.googleAuth !== "READY") {
      setGoogleSettings((prev) => ({ ...prev, enabled: false }));
    }
  }, [configStatus]);

  const updateSettings = (patch: Partial<AppSettings>) => {
    setAppSettings((prev) => ({
      ...prev,
      ...patch,
      agePreset: patch.agePreset ?? "custom",
      maxAllowedLevel: patch.maxAllowedLevel ?? prev.maxAllowedLevel,
      allowedLevels: patch.maxAllowedLevel ? buildAllowedLevels(patch.maxAllowedLevel) : prev.allowedLevels
    }));
  };

  const updateEffects = (patch: Partial<AppSettings["correctEffects"]>) => {
    setAppSettings((prev) => ({
      ...prev,
      agePreset: "custom",
      correctEffects: { ...prev.correctEffects, ...patch }
    }));
  };

  const updateTheme = (patch: Partial<AppSettings["customTheme"]>) => {
    setAppSettings((prev) => ({
      ...prev,
      agePreset: "custom",
      customTheme: { ...prev.customTheme, ...patch }
    }));
  };

  const applyPreset = (presetKey: string) => {
    const preset = agePresets[presetKey] || agePresets.custom;
    setAppSettings((prev) => ({
      ...prev,
      ...preset,
      maxAllowedLevel: preset.maxAllowedLevel,
      allowedLevels: buildAllowedLevels(preset.maxAllowedLevel),
      correctEffects: { ...prev.correctEffects, ...(preset.correctEffects || {}) },
      agePreset: presetKey
    }));
  };

  return (
    <div className="screen settings">
      <div className="settings-shell">
        <aside className="settings-nav">
          <div className="nav-title">Settings</div>
          {[
            { id: "start", label: "Start & Player" },
            { id: "account", label: "Account" },
            { id: "child-text", label: "Child & Text" },
            { id: "theme", label: "Theme & Visibility" },
            { id: "effects", label: "Effects" },
            { id: "rules", label: "Gameplay Rules" },
            { id: "input", label: "Input & Language" },
            { id: "content", label: "Content & Randomness" },
            { id: "preview", label: "Preview & Test" },
            { id: "diagnostics", label: "Diagnostics" },
            { id: "about", label: "About" },
            { id: "admin", label: "Admin" }
          ].map((item) => (
            <Button
              key={item.id}
              variant="subtle"
              size="sm"
              className="nav-button"
              onClick={() => {
                const el = document.getElementById(item.id);
                if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              {item.label}
            </Button>
          ))}
          <Divider my="sm" />
          <Button variant="light" size="sm" onClick={onBack}>Back to Main Menu</Button>
        </aside>

        <div className="settings-main">
          <div className="settings-hero">
            <Title order={2}>Settings & Admin</Title>
            <Text size="sm" c="dimmed">
              {adminPin
                ? "Settings are staged locally. Apply commits to backend."
                : "Changes apply immediately for authorized admin accounts."}
            </Text>
            <Group>
              <Button
                variant="light"
                disabled={!hasAnyUnsaved}
                onClick={() => {
                  onResetSettingsDraft();
                  setOpenaiKey("");
                  setOpenaiDirty(false);
                  if (savedEmailSettings) {
                    setEmailSettings({ ...savedEmailSettings, password: "" });
                    setEmailMessage("Unsaved email changes discarded.");
                  }
                  if (savedGoogleSettings) {
                    setGoogleSettings({ ...savedGoogleSettings, clientSecret: "" });
                    setGoogleMessage("Unsaved Google changes discarded.");
                  }
                  if (savedDbConfig) {
                    setDbConfig(savedDbConfig);
                    setDbMessage("Unsaved DB config changes discarded.");
                  }
                }}
              >
                Reset
              </Button>
              <Button disabled={!hasAnyUnsaved || !adminPin} onClick={() => void applyAllSettings()}>Apply</Button>
              {isAdmin && <Button variant="light" onClick={() => refreshConfigStatus().catch(() => null)}>Refresh status</Button>}
              <Text size="xs" c="dimmed">
                {lastSettingsAppliedAt ? `Last applied: ${new Date(lastSettingsAppliedAt).toLocaleString()}` : "Not applied yet"}
              </Text>
            </Group>
            {isAdmin && configStatus && (
              <Alert
                color={configStatus.overall === "READY" ? "green" : configStatus.overall === "DEGRADED" ? "yellow" : "red"}
                title={`Configuration: ${configStatus.overall}`}
              >
                Version {configStatus.config_version}. {configStatus.details.length} issue(s) reported.
              </Alert>
            )}
            {isAdmin && configStatus && configStatus.details.length > 0 && (
              <Card withBorder>
                <Stack gap="xs">
                  {configStatus.details.map((row) => (
                    <Text size="xs" key={`${row.key}-${row.message}`}>
                      [{row.severity}] {row.message} - {row.remediation_hint}
                    </Text>
                  ))}
                </Stack>
              </Card>
            )}
            {isAdmin && configStatusMessage && <Alert color="yellow">{configStatusMessage}</Alert>}
            {isAdmin && crashUnresolvedCount > 0 && (
              <Alert color="red" title="Unresolved crash events">
                {crashUnresolvedCount} crash event(s) require acknowledgment in Admin Diagnostics.
              </Alert>
            )}
          </div>
          <SettingsSection
            id="start"
            title="Start & Player"
            description="Set player name, mode, and contest rules from the main menu."
          >
            <Group>
              <Button variant="light" onClick={onBack}>Open Main Menu</Button>
            </Group>
          </SettingsSection>

          <SettingsSection
            id="account"
            title="Account"
            description="Manage your profile name and password."
          >
            {sessionUser ? (
              <>
                <SettingRow label="Display name" helper="Shown on leaderboard and in active session badges.">
                  <TextInput value={profileDisplayName} onChange={(e) => setProfileDisplayName(e.currentTarget.value)} />
                </SettingRow>
                {profileNameStatus && (
                  <div className="setting-row full">
                    <Alert color={profileNameAvailable ? "green" : "yellow"}>{profileNameStatus}</Alert>
                  </div>
                )}
                <SettingRow label="Profile actions" helper="Save your current display name.">
                  <Button
                    variant="light"
                    disabled={!profileDisplayName.trim() || !profileNameAvailable}
                    onClick={async () => {
                      try {
                        await API.updateUserProfile({ displayName: profileDisplayName.trim() });
                        setProfileMessage("Profile updated.");
                      } catch (err: any) {
                        setProfileMessage(err?.message || "Failed to update profile.");
                      }
                    }}
                  >
                    Save profile
                  </Button>
                </SettingRow>
                <Divider my="sm" />
                <SettingRow label="Current password" helper="Required to change your password.">
                  <TextInput type="password" value={profileCurrentPassword} onChange={(e) => setProfileCurrentPassword(e.currentTarget.value)} />
                </SettingRow>
                <SettingRow label="New password" helper="10-128 characters with at least one letter and one number.">
                  <TextInput type="password" value={profileNewPassword} onChange={(e) => setProfileNewPassword(e.currentTarget.value)} />
                </SettingRow>
                <SettingRow label="Confirm new password">
                  <TextInput type="password" value={profileConfirmPassword} onChange={(e) => setProfileConfirmPassword(e.currentTarget.value)} />
                </SettingRow>
                <SettingRow label="Password actions">
                  <Button
                    variant="light"
                    disabled={!profileCurrentPassword || !profileNewPassword || profileNewPassword !== profileConfirmPassword}
                    onClick={async () => {
                      try {
                        await API.changePassword({ currentPassword: profileCurrentPassword, newPassword: profileNewPassword });
                        setProfileCurrentPassword("");
                        setProfileNewPassword("");
                        setProfileConfirmPassword("");
                        setProfileMessage("Password updated.");
                      } catch (err: any) {
                        setProfileMessage(err?.message || "Failed to update password.");
                      }
                    }}
                  >
                    Change password
                  </Button>
                </SettingRow>
                {profileMessage && (
                  <div className="setting-row full">
                    <Alert color="blue">{profileMessage}</Alert>
                  </div>
                )}
              </>
            ) : (
              <Alert color="yellow">Sign in to manage your account profile.</Alert>
            )}
          </SettingsSection>

          <SettingsSection
            id="child-text"
            title="Child & Text"
            description="Size, readability, and allowed levels. Start with a preset, then refine."
          >
            <SettingRow label="Child age preset" helper="Applies age-appropriate defaults.">
              <Select
                value={appSettings.agePreset}
                onChange={(value) => applyPreset(value || "custom")}
                data={[
                  { value: "2-3", label: "2–3 years" },
                  { value: "3-4", label: "3–4 years" },
                  { value: "4-5", label: "4–5 years" },
                  { value: "5-6", label: "5–6 years" },
                  { value: "custom", label: "Custom" }
                ]}
              />
            </SettingRow>
            <SettingRow label="Text size" helper="Extra Large is best for early learners.">
              <SegmentedControl
                value={appSettings.textSize}
                onChange={(value) => updateSettings({ textSize: value as TextSize })}
                data={[
                  { value: "small", label: "Small" },
                  { value: "medium", label: "Medium" },
                  { value: "large", label: "Large" },
                  { value: "xlarge", label: "Extra Large" }
                ]}
              />
            </SettingRow>
            <SettingRow label="Auto-fit text" helper="Scales to fit the stage (recommended).">
              <Switch
                checked={appSettings.autoFitText}
                onChange={(e) => updateSettings({ autoFitText: e.currentTarget.checked })}
              />
            </SettingRow>
            <SettingRow label="Stage padding" helper="Give the task more or less space.">
              <Select
                value={appSettings.stagePadding}
                onChange={(value) => updateSettings({ stagePadding: (value || "medium") as AppSettings["stagePadding"] })}
                data={[
                  { value: "small", label: "Small" },
                  { value: "medium", label: "Medium" },
                  { value: "large", label: "Large" }
                ]}
              />
            </SettingRow>
            <SettingRow label="Max level (up to)" helper="Levels 1 through N are allowed.">
              <Select
                value={String(appSettings.maxAllowedLevel)}
                onChange={(value) => updateSettings({ maxAllowedLevel: Number(value || 5) })}
                data={[1, 2, 3, 4, 5].map((lvl) => ({ value: String(lvl), label: `Up to Level ${lvl}` }))}
              />
            </SettingRow>
            {levelConverted && (
              <div className="setting-row full">
                <Alert color="yellow" title="Converted">
                  Allowed levels were converted to “Up to Level {appSettings.maxAllowedLevel}” for simplicity.
                </Alert>
              </div>
            )}
            <SettingRow label="Differentiate 0 and O" helper="Makes zero visually distinct (recommended).">
              <Switch
                checked={appSettings.differentiateZero}
                onChange={(e) => updateSettings({ differentiateZero: e.currentTarget.checked })}
              />
            </SettingRow>
            <SettingRow label="Zero marker style" helper="Choose how zero is marked.">
              <Select
                value={appSettings.zeroStyle}
                onChange={(value) => updateSettings({ zeroStyle: (value || "dot") as AppSettings["zeroStyle"] })}
                data={[
                  { value: "dot", label: "Bottom-left dot" },
                  { value: "slashed", label: "Slashed 0 (legacy)" },
                  { value: "dotted", label: "Center dot (legacy)" }
                ]}
              />
            </SettingRow>
          </SettingsSection>

          <SettingsSection
            id="theme"
            title="Theme & Visibility"
            description="Pick a palette and enforce contrast safety automatically."
          >
            <SettingRow label="Theme preset" helper="Choose a base palette.">
              <Select
                value={appSettings.theme}
                onChange={(value) => updateSettings({ theme: (value || "warm_playful") as ThemeName })}
                data={[
                  { value: "high_contrast", label: "High Contrast" },
                  { value: "soft_pastel", label: "Soft Pastel" },
                  { value: "dark_calm", label: "Dark Calm" },
                  { value: "warm_playful", label: "Warm Playful" },
                  { value: "custom", label: "Custom" }
                ]}
              />
            </SettingRow>
            <SettingRow label="Low stimulation mode" helper="Softer colors and calmer motion.">
              <Switch
                checked={appSettings.lowStimulation}
                onChange={(e) => updateSettings({ lowStimulation: e.currentTarget.checked })}
              />
            </SettingRow>
            <SettingRow label="Flat theme" helper="No gradients or shadows.">
              <Switch
                checked={appSettings.flatTheme}
                onChange={(e) => updateSettings({ flatTheme: e.currentTarget.checked })}
              />
            </SettingRow>
            {appSettings.theme === "custom" && (
              <SettingRow label="Custom colors" helper="Edit specific tokens.">
                <div className="color-grid">
                  {[
                    { key: "background", label: "Background" },
                    { key: "backgroundAlt", label: "Gradient" },
                    { key: "panel", label: "Panel" },
                    { key: "text", label: "Text" },
                    { key: "mutedText", label: "Muted text" },
                    { key: "accent", label: "Accent" },
                    { key: "highlight", label: "Highlight" },
                    { key: "correct", label: "Correct" },
                    { key: "mistake", label: "Try again" }
                  ].map((item) => (
                    <ColorInput
                      key={item.key}
                      label={item.label}
                      value={(appSettings.customTheme as any)[item.key]}
                      onChange={(value) => updateTheme({ [item.key]: value } as any)}
                    />
                  ))}
                </div>
              </SettingRow>
            )}
            <SettingRow label="Theme preview" helper="Live preview of the selected palette.">
              <ThemePreview theme={themePreview} flat={appSettings.flatTheme} />
            </SettingRow>
            <Divider my="sm" />
            <SettingRow label="Visibility Guard" helper="Auto-fix contrast to AA or AAA.">
              <Select
                value={appSettings.visibilityGuard}
                onChange={(value) => updateSettings({ visibilityGuard: (value || "aaa") as AppSettings["visibilityGuard"] })}
                data={[
                  { value: "off", label: "Off" },
                  { value: "aa", label: "AA" },
                  { value: "aaa", label: "AAA (recommended)" }
                ]}
              />
            </SettingRow>
            <SettingRow label="Developer: APCA estimate" helper="Informational only (WCAG 3 draft).">
              <Switch
                checked={appSettings.apcaDeveloper}
                onChange={(e) => updateSettings({ apcaDeveloper: e.currentTarget.checked })}
              />
            </SettingRow>
            {contrastReport?.adjusted && (
              <div className="setting-row full">
                <Alert color="yellow" title="Adjusted for visibility">
                  Some colors were adjusted to meet contrast requirements.
                </Alert>
              </div>
            )}
            <SettingRow label="Visibility tools" helper="See ratios and apply fixes.">
              <Group gap="sm">
                <Button variant="light" onClick={onApplyVisibilityFix}>Fix now</Button>
                <Tooltip
                  label={
                    <div>
                      {(contrastReport?.pairs || []).map((pair: any) => (
                        <div key={pair.name}>
                          {pair.name}: {pair.ratio.toFixed(2)} {pair.passAA ? "AA" : "AA fail"} / {pair.passAAA ? "AAA" : "AAA fail"}
                          {appSettings.apcaDeveloper && (
                            <span> | APCA≈{apcaEstimate(pair.fg, pair.bg)}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  }
                  withArrow
                >
                  <Badge variant="light">Explain</Badge>
                </Tooltip>
              </Group>
            </SettingRow>
          </SettingsSection>

          <SettingsSection
            id="effects"
            title="Effects"
            description="Customize the correct-answer experience and sensory intensity."
          >
            <SettingRow label="Visual set" helper="Stars, hearts, balloons, and more.">
              <Select
                value={appSettings.correctEffects.visualSet}
                onChange={(value) => updateEffects({ visualSet: (value || "stars") as VisualSet })}
                data={[
                  { value: "stars", label: "Stars" },
                  { value: "hearts", label: "Hearts" },
                  { value: "balloons", label: "Balloons" },
                  { value: "smiles", label: "Smiles" },
                  { value: "confetti", label: "Confetti" }
                ]}
              />
            </SettingRow>
            <SettingRow label="Randomize visual" helper="Rotate visuals on each correct answer.">
              <Switch
                checked={appSettings.correctEffects.randomizeVisual}
                onChange={(e) => updateEffects({ randomizeVisual: e.currentTarget.checked })}
              />
            </SettingRow>
            <SettingRow label="Animated" helper="Disable for calmer sessions.">
              <Switch
                checked={appSettings.correctEffects.animated}
                onChange={(e) => updateEffects({ animated: e.currentTarget.checked })}
              />
            </SettingRow>
            <SettingRow label="Transform letter" helper="Glow or bounce the current letter.">
              <Switch
                checked={appSettings.correctEffects.transformLetter}
                onChange={(e) => updateEffects({ transformLetter: e.currentTarget.checked })}
              />
            </SettingRow>
            <SettingSliderRow
              label="Animation speed"
              helper="Overall motion speed."
              min={0.5}
              max={1.5}
              step={0.05}
              value={appSettings.animationSpeed}
              onChange={(value) => updateSettings({ animationSpeed: value })}
              formatValue={(value) => `${value.toFixed(2)}x`}
            />
            <SettingSliderRow
              label="Effect duration"
              helper="How long the effect stays on screen."
              min={200}
              max={2000}
              step={50}
              value={appSettings.correctEffects.durationMs}
              onChange={(value) => updateEffects({ durationMs: value })}
              formatValue={(value) => `${Math.round(value)} ms`}
            />
            <SettingRow label="Intensity" helper="Lower for younger or sensitive kids.">
              <Select
                value={appSettings.correctEffects.intensity}
                onChange={(value) => updateEffects({ intensity: (value || "medium") as Intensity })}
                data={[
                  { value: "very_low", label: "Very Low" },
                  { value: "low", label: "Low" },
                  { value: "medium", label: "Medium" },
                  { value: "high", label: "High" }
                ]}
              />
            </SettingRow>
            <SettingRow label="Variation" helper="Younger toddlers prefer predictability.">
              <Select
                value={appSettings.correctEffects.variation}
                onChange={(value) => updateEffects({ variation: (value || "small") as Variation })}
                data={[
                  { value: "same", label: "Same every time" },
                  { value: "small", label: "Small variation" },
                  { value: "high", label: "High variation" }
                ]}
              />
            </SettingRow>
            <SettingRow label="Sound" helper="Choose a gentle sound.">
              <Select
                value={appSettings.correctEffects.sound}
                onChange={(value) => updateEffects({ sound: (value || "chime") as SoundName })}
                data={[
                  { value: "chime", label: "Gentle chime" },
                  { value: "pop", label: "Pop" },
                  { value: "bell", label: "Soft bell" },
                  { value: "sparkle", label: "Sparkle" },
                  { value: "off", label: "Off" }
                ]}
              />
            </SettingRow>
            <SettingRow label="Randomize sound" helper="Rotate sound per correct answer.">
              <Switch
                checked={appSettings.correctEffects.randomizeSound}
                onChange={(e) => updateEffects({ randomizeSound: e.currentTarget.checked })}
              />
            </SettingRow>
            <SettingSliderRow
              label="Volume"
              helper="Respect sensory sensitivity."
              min={0}
              max={100}
              step={1}
              value={Math.round(appSettings.correctEffects.volume * 100)}
              onChange={(value) => updateEffects({ volume: value / 100 })}
              formatValue={(value) => `${Math.round(value)}%`}
            />
            <SettingRow label="Sound enabled" helper="Mute all effects.">
              <Switch
                checked={appSettings.soundEnabled}
                onChange={(e) => updateSettings({ soundEnabled: e.currentTarget.checked })}
              />
            </SettingRow>
          </SettingsSection>

          <SettingsSection
            id="rules"
            title="Gameplay Rules"
            description="Configure multi-symbol typing behavior."
          >
            <SettingRow label="Per-character progress" helper="Show progress for words.">
              <Switch
                checked={appSettings.perCharProgress}
                onChange={(e) => updateSettings({ perCharProgress: e.currentTarget.checked })}
              />
            </SettingRow>
            <SettingRow label="Wrong character behavior" helper="How the caret reacts.">
              <Select
                value={appSettings.wrongCharBehavior}
                onChange={(value) => updateSettings({ wrongCharBehavior: (value || "block") as AppSettings["wrongCharBehavior"] })}
                data={[
                  { value: "block", label: "Block (caret stays)" },
                  { value: "retry", label: "Allow retry" },
                  { value: "skip", label: "Skip character" }
                ]}
              />
            </SettingRow>
            <SettingRow label="Streak policy" helper="How streaks are affected.">
              <Select
                value={appSettings.streakPolicy}
                onChange={(value) => updateSettings({ streakPolicy: (value || "task_fail") as AppSettings["streakPolicy"] })}
                data={[
                  { value: "first_wrong", label: "Break on first wrong key" },
                  { value: "task_fail", label: "Break only if task had mistakes" },
                  { value: "never", label: "Never break streak" }
                ]}
              />
            </SettingRow>
            <SettingRow label="Rolling cart mode" helper="Moving string at higher levels.">
              <Select
                value={appSettings.rollingCart}
                onChange={(value) => updateSettings({ rollingCart: (value || "off") as AppSettings["rollingCart"] })}
                data={[
                  { value: "off", label: "Off" },
                  { value: "on", label: "On" }
                ]}
              />
            </SettingRow>
            <SettingRow label="Rolling cart intensity" helper="Motion strength.">
              <Select
                value={appSettings.rollingIntensity}
                onChange={(value) => updateSettings({ rollingIntensity: (value || "minimal") as AppSettings["rollingIntensity"] })}
                data={[
                  { value: "minimal", label: "Minimal" },
                  { value: "normal", label: "Normal" }
                ]}
              />
            </SettingRow>
            <SettingRow label="Space required between words" helper="Press space to advance sentences.">
              <Switch
                checked={appSettings.spaceRequired}
                onChange={(e) => updateSettings({ spaceRequired: e.currentTarget.checked })}
              />
            </SettingRow>
          </SettingsSection>

          <SettingsSection
            id="input"
            title="Input & Language"
            description="Keyboard guidance and safety warnings."
          >
            <SettingRow label="Show language reminder" helper="Warn when keyboard is not English.">
              <Switch
                checked={appSettings.languageReminder}
                onChange={(e) => updateSettings({ languageReminder: e.currentTarget.checked })}
              />
            </SettingRow>
            <SettingRow label="Protect function keys (F1–F12)" helper="Blocks first press to prevent accidental browser actions.">
              <Switch
                checked={appSettings.protectFunctionKeys}
                onChange={(e) => updateSettings({ protectFunctionKeys: e.currentTarget.checked })}
              />
            </SettingRow>
            <SettingRow label="Warn on exit during contest" helper="Show a browser warning if tab is closed.">
              <Switch
                checked={appSettings.warnOnExitContest}
                onChange={(e) => updateSettings({ warnOnExitContest: e.currentTarget.checked })}
              />
            </SettingRow>
          </SettingsSection>

          <SettingsSection
            id="content"
            title="Content & Randomness"
            description="Manage vocabulary packs and generation."
          >
            {isAdmin ? (
              <>
                <div className="setting-row full">
                  <Button variant="light" onClick={() => setLanguagePackModalOpen(true)}>Open Language Packs</Button>
                </div>
                <Modal opened={languagePackModalOpen} onClose={() => setLanguagePackModalOpen(false)} title="Language Packs" size="xl" centered>
                  <div className="vocab-manager">
                    <Group justify="space-between" mb="sm">
                      <Button
                        variant="light"
                        onClick={async () => {
                          const exported = await API.exportLanguagePacks();
                          setPackJson(JSON.stringify(exported, null, 2));
                        }}
                      >
                        Export JSON
                      </Button>
                      <Button
                        variant="light"
                        onClick={async () => {
                          try {
                            const parsed = JSON.parse(packJson || "{}");
                            await API.importLanguagePacks(parsed);
                            onReloadPacks();
                            setOpenaiStatus("Pack JSON imported.");
                          } catch {
                            setOpenaiStatus("Invalid JSON for import.");
                          }
                        }}
                      >
                        Import JSON
                      </Button>
                    </Group>
                    <Textarea
                      label="Import / Export JSON"
                      value={packJson}
                      onChange={(e) => setPackJson(e.currentTarget.value)}
                      minRows={4}
                    />
                    <Group align="flex-end" style={{ flexWrap: "wrap" }}>
                      <TextInput
                        label="Topic"
                        value={generateName}
                        onChange={(e) => setGenerateName(e.currentTarget.value)}
                        placeholder="e.g. animals"
                      />
                      <Select
                        label="Pack type"
                        value={generateType}
                        onChange={(value) => setGenerateType((value || "level2") as any)}
                        data={[
                          { value: "level2", label: "Level 2 words" },
                          { value: "level3", label: "Level 3 words" },
                          { value: "sentence_words", label: "Sentence words" }
                        ]}
                      />
                      <NumberInput
                        label="Count"
                        min={10}
                        max={200}
                        value={generateCount}
                        onChange={(value) => setGenerateCount(Number(value) || 10)}
                      />
                      <Button
                        disabled={!openaiGenerationReady}
                        onClick={async () => {
                          await onGenerate({ topic: generateName, count: generateCount, type: generateType, language: selectedLanguage });
                          onReloadPacks();
                        }}
                      >
                        Generate Draft
                      </Button>
                    </Group>
                    {!openaiGenerationReady && (
                      <Alert color="yellow" title="OpenAI generation unavailable">
                        {openaiDirty
                          ? "Apply settings to enable generation."
                          : "Configure your OpenAI key to enable generation. Built-in EN/RU packs remain available."}
                      </Alert>
                    )}

                    <div className="pack-list">
                      {packs.map((pack) => (
                        <div className="pack" key={pack.id}>
                          <div className="pack-header">
                            <strong>{pack.name}</strong>
                            <span>{pack.packType}</span>
                            <span>{pack.active ? "PUBLISHED" : "DRAFT"}</span>
                          </div>
                          <Textarea
                            value={manualEdit[pack.id] ?? pack.items.join(", ")}
                            onChange={(e) => setManualEdit({ ...manualEdit, [pack.id]: e.currentTarget.value })}
                            minRows={3}
                          />
                          <div className="row">
                            <Button variant="light" onClick={() => onActivatePack(pack.id)}>Publish</Button>
                            <Button
                              variant="light"
                              onClick={() => {
                                const raw = manualEdit[pack.id] ?? pack.items.join(", ");
                                onUpdatePack(pack.id, { items: raw.split(/\s*,\s*/).filter(Boolean) });
                              }}
                            >
                              Save
                            </Button>
                            <Button variant="light" onClick={() => onDeletePack(pack.id)}>Unpublish</Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </Modal>
              </>
            ) : (
              <div className="setting-row full">
                <Alert color="yellow" title="Admin access required">
                  Sign in as OWNER or ADMIN to manage language packs.
                </Alert>
              </div>
            )}
          </SettingsSection>

          <SettingsSection
            id="preview"
            title="Preview & Test"
            description="Single source of truth for previews and safe testing."
          >
            <TestPlayground settings={appSettings} onUpdateSettings={updateSettings} />
          </SettingsSection>

          <SettingsSection
            id="diagnostics"
            title="Diagnostics"
            description="Tools for debugging layout and contrast."
          >
            <SettingRow label="Debug layout overlay" helper="Show fit metrics during gameplay.">
              <Switch
                checked={appSettings.debugLayout}
                onChange={(e) => updateSettings({ debugLayout: e.currentTarget.checked })}
              />
            </SettingRow>
            <SettingRow label="Show bounds" helper="Outline text fit boxes.">
              <Switch
                checked={appSettings.showBounds}
                onChange={(e) => updateSettings({ showBounds: e.currentTarget.checked })}
              />
            </SettingRow>
            <SettingRow label="Diagnostics pages" helper="Open built-in QA routes.">
              <Group>
                <Button variant="light" onClick={() => window.open("/diagnostics/text-fit", "_blank")}>Text Fit</Button>
                <Button variant="light" onClick={() => window.open("/diagnostics/ux", "_blank")}>UX Diagnostics</Button>
                <Button variant="light" onClick={() => window.open("/diagnostics/controls", "_blank")}>Controls</Button>
              </Group>
            </SettingRow>
          </SettingsSection>

          <SettingsSection
            id="about"
            title="About"
            description="Build and release metadata."
          >
            <SettingRow label="Version" helper="Semantic version with build metadata.">
              <Text>{publicVersion ? `${publicVersion.version} (build ${publicVersion.build})` : "unknown"}</Text>
            </SettingRow>
            <SettingRow label="Commit" helper="Source commit currently running.">
              <Text>{publicVersion?.commit || "unknown"}</Text>
            </SettingRow>
            <SettingRow label="Build time" helper="UTC build timestamp, if available.">
              <Text>{publicVersion?.buildTime || "n/a"}</Text>
            </SettingRow>
            <SettingRow label="Project links" helper="Repository and support contacts.">
              <Group>
                <Button
                  variant="light"
                  component="a"
                  href={publicVersion?.githubUrl || "https://github.com/viktordrukker/ktrain"}
                  target="_blank"
                >
                  GitHub
                </Button>
                <Button
                  variant="light"
                  component="a"
                  href={publicVersion?.website || "https://thedrukkers.com"}
                  target="_blank"
                >
                  thedrukkers.com
                </Button>
                <Button
                  variant="light"
                  component="a"
                  href={publicVersion?.contact || "mailto:vdrukker@thedrukkers.com"}
                >
                  Contact
                </Button>
                <Button variant="light" component="a" href="/about">
                  Public About
                </Button>
              </Group>
            </SettingRow>
          </SettingsSection>

          <SettingsSection
            id="admin"
            title="Admin"
            description="OpenAI, resets, and admin authorization."
          >
            {isAdmin ? (
              <>
                <div className="setting-row full">
                  <Alert color="blue" title="Admin Authorization">
                    Access is controlled by OWNER/ADMIN role. Admin PIN is fully removed.
                  </Alert>
                </div>
            <Divider my="sm" />
            <SettingRow label="Database status" helper="Current backend and runtime status.">
              <Group>
                <Button variant="light" loading={dbBusy} onClick={refreshDb}>Refresh DB status</Button>
                <Badge variant="light">Active: {dbStatus?.activeDriver || "unknown"}</Badge>
                <Badge variant="light">Maintenance: {dbStatus?.maintenanceMode ? "ON" : "OFF"}</Badge>
              </Group>
            </SettingRow>
            <Divider my="sm" />
            <SettingRow label="SMTP enabled" helper="Optional service. Disable to keep app running without email.">
              <Switch
                checked={Boolean(emailSettings.enabled)}
                disabled={smtpToggleLocked}
                onChange={(e) => setEmailSettings({ ...emailSettings, enabled: e.currentTarget.checked })}
              />
              {smtpToggleLocked && <Text size="xs" c="dimmed">Add working configuration to enable this feature.</Text>}
            </SettingRow>
            <SettingRow label="SMTP host" helper="Used for password reset emails and notifications.">
              <TextInput value={emailSettings.host} onChange={(e) => setEmailSettings({ ...emailSettings, host: e.currentTarget.value })} placeholder="smtp.example.com" />
            </SettingRow>
            <SettingRow label="SMTP port" helper="Common: 587 (STARTTLS) or 465 (SSL).">
              <NumberInput value={emailSettings.port} onChange={(value) => setEmailSettings({ ...emailSettings, port: Number(value) || 587 })} />
            </SettingRow>
            <SettingRow label="SMTP username" helper="Account username for SMTP auth.">
              <TextInput value={emailSettings.username} onChange={(e) => setEmailSettings({ ...emailSettings, username: e.currentTarget.value })} />
            </SettingRow>
            <SettingRow label="SMTP password" helper={emailSettings.hasPassword ? "Stored securely. Leave blank to keep current." : "Stored securely (encrypted at rest)."}>
              <TextInput type="password" value={emailSettings.password} onChange={(e) => setEmailSettings({ ...emailSettings, password: e.currentTarget.value })} />
            </SettingRow>
            <SettingRow label="From address" helper="Sender mailbox address.">
              <TextInput value={emailSettings.fromAddress} onChange={(e) => setEmailSettings({ ...emailSettings, fromAddress: e.currentTarget.value })} />
            </SettingRow>
            <SettingRow label="From name" helper="Sender display name.">
              <TextInput value={emailSettings.fromName} onChange={(e) => setEmailSettings({ ...emailSettings, fromName: e.currentTarget.value })} />
            </SettingRow>
            <SettingRow label="Email service actions" helper="Save settings and send a test email.">
              <Group>
                <TextInput value={emailTestTo} onChange={(e) => setEmailTestTo(e.currentTarget.value)} placeholder="test@domain.com" />
                <Button variant="light" onClick={saveEmailServiceSettings}>Save email settings</Button>
                <Button variant="light" onClick={sendEmailTest}>Send test email</Button>
              </Group>
            </SettingRow>
            {emailMessage && (
              <div className="setting-row full">
                <Alert color="yellow" title="Email Service">
                  {emailMessage}
                </Alert>
              </div>
            )}
            <Divider my="sm" />
            <SettingRow label="Google auth enabled" helper="Optional login method for end users.">
              <Switch
                checked={Boolean(googleSettings.enabled)}
                disabled={googleToggleLocked}
                onChange={(e) => setGoogleSettings({ ...googleSettings, enabled: e.currentTarget.checked })}
              />
              {googleToggleLocked && <Text size="xs" c="dimmed">Add working configuration to enable this feature.</Text>}
            </SettingRow>
            <SettingRow label="Google client ID" helper="OAuth client ID for browser sign-in.">
              <TextInput value={googleSettings.clientId} onChange={(e) => setGoogleSettings({ ...googleSettings, clientId: e.currentTarget.value })} />
            </SettingRow>
            <SettingRow label="Google client secret" helper={googleSettings.hasClientSecret ? "Stored securely. Leave blank to keep current." : "Stored securely (encrypted at rest)."}>
              <TextInput type="password" value={googleSettings.clientSecret} onChange={(e) => setGoogleSettings({ ...googleSettings, clientSecret: e.currentTarget.value })} />
            </SettingRow>
            <SettingRow label="Google auth actions" helper="Save and validate Google auth configuration.">
              <Group>
                <Button variant="light" onClick={saveGoogleSettings}>Save Google settings</Button>
                <Button
                  variant="light"
                  onClick={async () => {
                    try {
                      const result = await API.testGoogleConfig();
                      setGoogleMessage(`Google config: ${result?.result?.status || "READY"}`);
                      await refreshConfigStatus();
                    } catch (err: any) {
                      setGoogleMessage(err?.message || "Google auth test failed.");
                    }
                  }}
                >
                  Test Google settings
                </Button>
              </Group>
            </SettingRow>
            {googleMessage && (
              <div className="setting-row full">
                <Alert color="yellow" title="Google Auth">
                  {googleMessage}
                </Alert>
              </div>
            )}
            <SettingRow label="SQLite path" helper="Used when driver is sqlite.">
              <TextInput
                value={dbConfig.sqlitePath}
                onChange={(e) => setDbConfig((prev) => ({ ...prev, sqlitePath: e.currentTarget.value }))}
                placeholder="/data/ktrain.sqlite"
              />
            </SettingRow>
            <SettingRow label="Postgres connection string" helper="Optional. If set, host/port/db/user/password are ignored.">
              <TextInput
                value={dbConfig.postgres.connectionString || ""}
                onChange={(e) => setDbConfig((prev) => ({ ...prev, postgres: { ...prev.postgres, connectionString: e.currentTarget.value } }))}
                placeholder="postgres://user:pass@host:5432/db"
              />
            </SettingRow>
            <SettingRow label="Postgres host" helper="Used when connection string is empty.">
              <TextInput
                value={dbConfig.postgres.host}
                onChange={(e) => setDbConfig((prev) => ({ ...prev, postgres: { ...prev.postgres, host: e.currentTarget.value } }))}
              />
            </SettingRow>
            <SettingRow label="Postgres port" helper="Default 5432.">
              <NumberInput
                value={dbConfig.postgres.port}
                min={1}
                max={65535}
                onChange={(value) => setDbConfig((prev) => ({ ...prev, postgres: { ...prev.postgres, port: Number(value) || 5432 } }))}
              />
            </SettingRow>
            <SettingRow label="Postgres database" helper="Database name.">
              <TextInput
                value={dbConfig.postgres.database}
                onChange={(e) => setDbConfig((prev) => ({ ...prev, postgres: { ...prev.postgres, database: e.currentTarget.value } }))}
              />
            </SettingRow>
            <SettingRow label="Postgres user" helper="DB username.">
              <TextInput
                value={dbConfig.postgres.user}
                onChange={(e) => setDbConfig((prev) => ({ ...prev, postgres: { ...prev.postgres, user: e.currentTarget.value } }))}
              />
            </SettingRow>
            <SettingRow label="Postgres password" helper="Stored server-side in runtime config.">
              <TextInput
                type="password"
                value={dbConfig.postgres.password}
                onChange={(e) => setDbConfig((prev) => ({ ...prev, postgres: { ...prev.postgres, password: e.currentTarget.value } }))}
              />
            </SettingRow>
            <SettingRow label="DB actions" helper="Save config, switch backend, or rollback to last dump.">
              <Group>
                <Button variant="light" loading={dbBusy} onClick={testPostgresConnection}>Test Postgres connection</Button>
                <Button
                  variant="light"
                  loading={dbBusy}
                  onClick={async () => {
                    setDbBusy(true);
                    try {
                      const result = await API.testDatabaseConfig();
                      setDbMessage(`DB self-test: ${result?.result?.status || "READY"}`);
                    } catch (err: any) {
                      setDbMessage(err?.message || "DB self-test failed");
                    } finally {
                      setDbBusy(false);
                    }
                  }}
                >
                  Test active DB
                </Button>
                <Button variant="light" loading={dbBusy} onClick={saveDbConfig}>Save DB config</Button>
                <Button variant="light" color="teal" loading={dbBusy} onClick={() => switchDb("sqlite")}>Switch to SQLite</Button>
                <Button variant="light" color="blue" loading={dbBusy} onClick={() => switchDb("postgres")}>Switch to Postgres</Button>
                <Button variant="light" color="red" loading={dbBusy} onClick={rollbackDb}>Rollback DB switch</Button>
              </Group>
            </SettingRow>
            <SettingRow label="Google auth config" helper="Validate whether Google auth is configured and usable.">
              <Button
                variant="light"
                onClick={async () => {
                  try {
                    const result = await API.testGoogleConfig();
                    setDbMessage(`Google auth: ${result?.result?.status || "READY"}`);
                    await refreshConfigStatus();
                  } catch (err: any) {
                    setDbMessage(err?.message || "Google config check failed");
                  }
                }}
              >
                Test Google config
              </Button>
            </SettingRow>
            {dbStatus?.counts && (
              <div className="setting-row full">
                <Alert color="blue" title="DB counts">
                  settings={dbStatus.counts.settings}, leaderboard={dbStatus.counts.leaderboard}, vocab_packs={dbStatus.counts.vocab_packs}
                </Alert>
              </div>
            )}
            {dbMessage && (
              <div className="setting-row full">
                <Alert color="yellow" title="Database backend">
                  {dbMessage}
                </Alert>
              </div>
            )}
            <Divider my="sm" />
            <SettingRow label="Crash diagnostics" helper="Recent fatal/startup crashes and acknowledgment state.">
              <Group>
                <Button variant="light" loading={crashBusy} onClick={refreshCrashes}>Refresh crashes</Button>
                <Badge variant="light">Unresolved: {crashUnresolvedCount}</Badge>
              </Group>
            </SettingRow>
            {crashEvents.length > 0 && (
              <SettingRow label="Recent crash events" helper="Newest first. Select one to inspect details.">
                <Select
                  value={selectedCrash ? String(selectedCrash.id) : ""}
                  onChange={(value) => {
                    const found = crashEvents.find((row) => String(row.id) === String(value || ""));
                    setSelectedCrash(found || null);
                  }}
                  data={crashEvents.map((row) => ({
                    value: String(row.id),
                    label: `${new Date(row.occurredAt).toLocaleString()} | ${row.crashType} | ${row.resolved ? "resolved" : "unresolved"}`
                  }))}
                />
              </SettingRow>
            )}
            {selectedCrash && (
              <div className="setting-row full">
                <Alert color={selectedCrash.resolved ? "blue" : "red"} title={`Crash #${selectedCrash.id}`}>
                  <div><strong>When:</strong> {new Date(selectedCrash.occurredAt).toLocaleString()}</div>
                  <div><strong>Type:</strong> {selectedCrash.crashType}</div>
                  <div><strong>Version:</strong> {selectedCrash.appVersion || "n/a"} build {selectedCrash.appBuild || "n/a"}</div>
                  <div><strong>Phase:</strong> {selectedCrash.startupPhase || "n/a"}</div>
                  <div><strong>Error:</strong> {selectedCrash.errorName || "Error"}: {selectedCrash.errorMessage || "n/a"}</div>
                  <div><strong>Acknowledged:</strong> {selectedCrash.acknowledgedAt ? `${selectedCrash.acknowledgedAt} by ${selectedCrash.acknowledgedBy || "admin"}` : "no"}</div>
                  <Textarea
                    mt="sm"
                    minRows={4}
                    value={selectedCrash.stackTrace || ""}
                    readOnly
                    autosize
                  />
                  {!selectedCrash.resolved && (
                    <Button mt="sm" variant="light" color="orange" onClick={() => acknowledgeCrash(Number(selectedCrash.id))}>
                      Mark acknowledged
                    </Button>
                  )}
                </Alert>
              </div>
            )}
            {crashMessage && (
              <div className="setting-row full">
                <Alert color="yellow" title="Crash diagnostics">
                  {crashMessage}
                </Alert>
              </div>
            )}
            <Divider my="sm" />
            <SettingRow label="OpenAI API key" helper="Server-side only.">
              <TextInput
                value={openaiKey}
                onChange={(e) => {
                  setOpenaiKey(e.currentTarget.value);
                  setOpenaiDirty(Boolean(e.currentTarget.value.trim()));
                }}
                placeholder={openaiConfigured ? "Configured (enter new key to rotate)" : "sk-..."}
              />
            </SettingRow>
            <SettingRow label="Store key in database" helper="Insecure. Use only on trusted devices.">
              <Switch
                checked={storeKey}
                onChange={(e) => setStoreKey(e.currentTarget.checked)}
              />
            </SettingRow>
            <SettingRow label="Test key" helper="Check connectivity and permissions.">
              <Button
                variant="light"
                onClick={async () => {
                  setOpenaiStatus("");
                  try {
                    const res = await onTestKey({ apiKey: openaiKey, storeKey });
                    setOpenaiStatus(res.ok ? "Key works!" : "Key failed");
                  } catch {
                    setOpenaiStatus("Key test failed");
                  }
                }}
              >
                Test key
              </Button>
            </SettingRow>
            {openaiDirty && (
              <div className="setting-row full">
                <Alert color="blue">OpenAI key changed. Apply settings to save it.</Alert>
              </div>
            )}
            {openaiStatus && <div className="status">{openaiStatus}</div>}
            <Divider my="sm" />
            <SettingRow label="Reset data" helper="Resets are permanent.">
              <Group>
                {"all leaderboard results vocab".split(" ").map((scope) => (
                  <Button
                    key={scope}
                    variant="light"
                    onClick={() => {
                      if (window.confirm(`Reset ${scope}? This cannot be undone.`)) {
                        onReset(scope);
                      }
                    }}
                  >
                    Reset {scope}
                  </Button>
                ))}
                <Button
                  variant="light"
                  onClick={() => {
                    if (window.confirm("Seed defaults? This replaces existing vocab packs.")) {
                      onSeed();
                    }
                  }}
                >
                  Seed defaults
                </Button>
              </Group>
            </SettingRow>
              </>
            ) : (
              <div className="setting-row full">
                <Alert color="red" title="Not authorized">
                  Admin settings are restricted to OWNER/ADMIN accounts.
                </Alert>
              </div>
            )}
          </SettingsSection>

          {statusMessage && <div className="status">{statusMessage}</div>}
        </div>
      </div>
    </div>
  );
}

function CorrectEffects({
  show,
  tick,
  seed,
  settings,
  intensity
}: {
  show: boolean;
  tick: number;
  seed: number;
  settings: AppSettings;
  intensity: Intensity;
}) {
  const [visible, setVisible] = useState(false);
  const duration = Math.max(250, settings.correctEffects.durationMs / settings.animationSpeed);
  const config = INTENSITY_CONFIG[intensity];
  const visuals = Object.keys(VISUAL_SET_FILES) as VisualSet[];
  const visual = settings.correctEffects.randomizeVisual
    ? visuals[Math.abs(seed + tick) % visuals.length]
    : settings.correctEffects.visualSet;

  useEffect(() => {
    if (!show) return;
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), duration);
    return () => window.clearTimeout(timer);
  }, [show, tick, duration]);

  const particles = useMemo(() => {
    if (!show) return [];
    const list = buildParticles(config.count, seed + tick, settings.correctEffects.variation);
    return list.map((p) => ({
      ...p,
      size: p.size * (config.size / 42)
    }));
  }, [show, tick, seed, config.count, config.size, settings.correctEffects.variation]);

  if (!visible) return null;

  return (
    <div
      className={"effect-layer" + (settings.correctEffects.animated ? "" : " static")}
      style={{ "--effect-duration": `${duration}ms` } as React.CSSProperties}
    >
      {particles.map((p) => (
        <img
          key={p.id}
          src={VISUAL_SET_FILES[visual]}
          className="effect-item"
          style={{
            left: `${p.x}%`,
            top: `${p.y}%`,
            width: p.size,
            height: p.size,
            animationDelay: `${p.delay}s`,
            transform: `rotate(${p.rotate}deg)`
          }}
        />
      ))}
    </div>
  );
}

function ThemePreview({ theme, flat }: { theme: AppSettings["customTheme"]; flat?: boolean }) {
  return (
    <div
      className="theme-preview"
      style={
        {
          "--bg": theme.background,
          "--bg-alt": theme.backgroundAlt,
          "--surface": theme.panel,
          "--text": theme.text,
          "--highlight": theme.highlight,
          "--correct": theme.correct,
          "--mistake": theme.mistake,
          background: flat ? theme.background : undefined
        } as React.CSSProperties
      }
    >
      <div className="theme-preview-panel">
        <div className="theme-preview-letter">A</div>
        <div className="theme-preview-row">
          <span className="theme-preview-good">Good job</span>
          <span className="theme-preview-bad">Try again</span>
        </div>
      </div>
    </div>
  );
}

function StatsBar({
  cpm,
  accuracy,
  incorrectRatio,
  tasksCompleted,
  streak,
  stars,
  trendLabel,
  timer
}: {
  cpm: number;
  accuracy: number;
  incorrectRatio: number;
  tasksCompleted: number;
  streak: number;
  stars: string;
  trendLabel: string;
  timer: number | null;
}) {
  return (
    <div className="stats-bar">
      <div className="stat">CPM: <strong>{cpm}</strong></div>
      <div className="stat">Accuracy: <strong>{accuracy}%</strong></div>
      <div className="stat">Try ratio: <strong>{incorrectRatio}</strong></div>
      <div className="stat">Done: <strong>{tasksCompleted}</strong></div>
      <div className="stat">Streak: <strong>{streak}</strong></div>
      <div className="stat">Stars: <strong>{stars}</strong></div>
      <div className="stat">Trend: <strong>{trendLabel || "—"}</strong></div>
      {timer !== null && <div className="timer compact">{timer}s</div>}
    </div>
  );
}

function TaskStage({
  currentTask,
  fitConfigCurrent,
  fitConfigSentence,
  appSettings,
  correctFlash,
  mistakeFlash,
  buffer,
  progress,
  caretIndex,
  expectSpace,
  fitMetrics,
  onMetrics
}: {
  currentTask: Task;
  fitConfigCurrent: FitConfig;
  fitConfigSentence: FitConfig;
  appSettings: AppSettings;
  correctFlash: boolean;
  mistakeFlash: boolean;
  buffer: string;
  progress: Array<"correct" | "wrong" | "pending">;
  caretIndex: number;
  expectSpace: boolean;
  fitMetrics: FitMetrics | null;
  onMetrics: (metrics: FitMetrics) => void;
}) {
  const paddingClass = `stage-padding-${appSettings.stagePadding}`;
  const showProgress = appSettings.perCharProgress && currentTask.answer.length > 1;
  const rolling = appSettings.rollingCart === "on";
  const reduceMotion = usePrefersReducedMotion();
  const cartSpeed = appSettings.rollingIntensity === "minimal" ? 0.2 : 0.4;
  const averageCharWidth = fitMetrics && currentTask.answer.length
    ? fitMetrics.text.width / currentTask.answer.length
    : 0;
  const rollingOffset = rolling && averageCharWidth ? averageCharWidth * caretIndex : 0;

  const renderProgress = () => {
    const chars = currentTask.prompt.split("");
    return (
      <span className="progress-word">
        {chars.map((char, idx) => {
          const status = progress[idx] || "pending";
          const isCurrent = idx === caretIndex && status === "pending";
          const zeroClass = appSettings.differentiateZero && char === "0"
            ? appSettings.zeroStyle === "dotted"
              ? " zero zero-dotted"
              : appSettings.zeroStyle === "slashed"
                ? " zero zero-slashed"
                : " zero zero-dot"
            : "";
          return (
            <span
              key={`${currentTask.id}-${idx}`}
              className={`char ${status}${isCurrent ? " current" : ""}${zeroClass}`}
            >
              {char}
            </span>
          );
        })}
      </span>
    );
  };
  return (
    <div className={`task-stage ${paddingClass}`}>
      <div className="task-stack horizontal">
        <div className="task current">
          <TaskText
            text={currentTask.prompt}
            config={fitConfigCurrent}
            showBounds={appSettings.showBounds}
            className="task-current-fit"
            textClassName={(correctFlash ? "correct " : "") + (mistakeFlash ? "mistake" : "")}
            dataId="current-task"
            onMetrics={onMetrics}
          >
            {showProgress ? (
              <span className={rolling ? "rolling-cart" : ""}>
                <span
                  className="rolling-track"
                  style={{
                    transform: rolling ? `translateX(calc(50% - ${rollingOffset}px))` : undefined,
                    transition: reduceMotion ? "none" : `transform ${cartSpeed}s ease-out`
                  }}
                >
                  {renderProgress()}
                </span>
              </span>
            ) : (
              renderZeroStyledText(currentTask.prompt, appSettings)
            )}
          </TaskText>
          {currentTask.sentence && (
            <div className="sentence-wrap">
              <TaskText
                text={currentTask.sentence}
                config={fitConfigSentence}
                showBounds={appSettings.showBounds}
                className="sentence-fit"
                textClassName="sentence sentence-text"
              >
                {currentTask.words?.map((word, idx) => (
                  <span
                    key={`${currentTask.id}-${idx}`}
                    className={idx === currentTask.wordIndex ? "sentence-word active" : "sentence-word"}
                  >
                    {renderZeroStyledText(word, appSettings)}
                  </span>
                ))}
              </TaskText>
            </div>
          )}
          <div className="buffer">{buffer}</div>
          {expectSpace && <div className="space-hint">Press ␣ Space</div>}
        </div>
      </div>
    </div>
  );
}

function QuickControls({
  appSettings,
  setAppSettings
}: {
  appSettings: AppSettings;
  setAppSettings: (value: AppSettings | ((prev: AppSettings) => AppSettings)) => void;
}) {
  return (
    <div className="quick-controls">
      <Select
        size="xs"
        value={appSettings.textSize}
        onChange={(value) => setAppSettings((prev) => ({ ...prev, textSize: (value || "large") as TextSize, agePreset: "custom" }))}
        data={[
          { value: "small", label: "Text S" },
          { value: "medium", label: "Text M" },
          { value: "large", label: "Text L" },
          { value: "xlarge", label: "Text XL" }
        ]}
      />
      <Select
        size="xs"
        value={appSettings.stagePadding}
        onChange={(value) => setAppSettings((prev) => ({ ...prev, stagePadding: (value || "medium") as AppSettings["stagePadding"], agePreset: "custom" }))}
        data={[
          { value: "small", label: "Pad S" },
          { value: "medium", label: "Pad M" },
          { value: "large", label: "Pad L" }
        ]}
      />
      <Select
        size="xs"
        value={appSettings.theme}
        onChange={(value) => setAppSettings((prev) => ({ ...prev, theme: (value || "warm_playful") as ThemeName, agePreset: "custom" }))}
        data={[
          { value: "high_contrast", label: "Theme: Contrast" },
          { value: "soft_pastel", label: "Theme: Pastel" },
          { value: "dark_calm", label: "Theme: Calm" },
          { value: "warm_playful", label: "Theme: Warm" },
          { value: "custom", label: "Theme: Custom" }
        ]}
      />
    </div>
  );
}

function CarriageBar({
  prevTask,
  nextTask,
  compactUI,
  fitConfigSecondary,
  appSettings,
  setAppSettings,
  onEnd,
  showControls = true
}: {
  prevTask?: Task;
  nextTask?: Task;
  compactUI: boolean;
  fitConfigSecondary: FitConfig;
  appSettings: AppSettings;
  setAppSettings: (value: AppSettings | ((prev: AppSettings) => AppSettings)) => void;
  onEnd: () => void;
  showControls?: boolean;
}) {
  return (
    <div className="carriage-bar">
      <div className="carriage-slot left">
        {!compactUI && prevTask && (
          <TaskText
            text={prevTask.prompt}
            config={fitConfigSecondary}
            className="task-secondary-fit"
            textClassName="faded-text"
            showBounds={appSettings.showBounds}
          >
            {renderZeroStyledText(prevTask.prompt, appSettings)}
          </TaskText>
        )}
      </div>
      <div className="carriage-slot center">
        {showControls && (
          <>
            <Button size="xs" variant="light" className="end-session" onClick={onEnd}>End Session</Button>
            <QuickControls appSettings={appSettings} setAppSettings={setAppSettings} />
            <div className="keyboard-indicator">Keyboard: English</div>
          </>
        )}
      </div>
      <div className="carriage-slot right">
        {!compactUI && nextTask && (
          <TaskText
            text={nextTask.prompt}
            config={fitConfigSecondary}
            className="task-secondary-fit"
            textClassName="faded-text"
            showBounds={appSettings.showBounds}
          >
            {renderZeroStyledText(nextTask.prompt, appSettings)}
          </TaskText>
        )}
      </div>
    </div>
  );
}

function LanguageBanner({ show, onDismiss }: { show: boolean; onDismiss: () => void }) {
  if (!show) return null;
  return (
    <div className="language-banner">
      <div className="language-text">
        Keyboard language is not English — please switch (Alt+Shift / Win+Space).
        <details>
          <summary>How to switch</summary>
          Use Alt+Shift (Windows) or Win+Space to switch to English.
        </details>
      </div>
      <Button size="xs" variant="light" onClick={onDismiss}>Hide</Button>
    </div>
  );
}

function FunctionKeyBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="language-banner function-banner">
      <div className="language-text">{message}</div>
      <Button size="xs" variant="light" onClick={onDismiss}>Hide</Button>
    </div>
  );
}

function ZeroHintBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="language-banner zero-hint">
      <div className="language-text">This is zero (0). This is letter O.</div>
      <Button size="xs" variant="light" onClick={onDismiss}>Got it</Button>
    </div>
  );
}

function DebugOverlay({ metrics, scale }: { metrics: FitMetrics; scale: number }) {
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });

  useEffect(() => {
    const update = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const spareWidth = metrics.container.width ? Math.round((metrics.spare.width / metrics.container.width) * 100) : 0;
  const spareHeight = metrics.container.height ? Math.round((metrics.spare.height / metrics.container.height) * 100) : 0;

  return (
    <div className="debug-overlay">
      <div><strong>Viewport</strong>: {viewport.width}×{viewport.height}</div>
      <div><strong>Container</strong>: {Math.round(metrics.container.width)}×{Math.round(metrics.container.height)}</div>
      <div><strong>Font</strong>: {Math.round(metrics.fontSize)}px</div>
      <div><strong>Scale</strong>: {scale.toFixed(2)}</div>
      <div><strong>Text</strong>: {Math.round(metrics.text.width)}×{Math.round(metrics.text.height)}</div>
      <div><strong>Spare</strong>: {spareWidth}% w / {spareHeight}% h</div>
    </div>
  );
}

function DiagnosticsPage({ settings }: { settings: AppSettings }) {
  const scale = TEXT_SCALE[settings.textSize];
  const config = makeFitConfig({ scale, autoFit: settings.autoFitText, allowWrap: false, variant: "current" });
  const sentenceConfig = makeFitConfig({ scale: scale * 0.6, autoFit: settings.autoFitText, allowWrap: true, variant: "current" });
  const cases = [
    { label: "Single Letter", text: "A", wrap: false },
    { label: "Digit", text: "8", wrap: false },
    { label: "Short Word", text: "CAT", wrap: false },
    { label: "Long Word", text: "ELEPHANT", wrap: false },
    { label: "Level 3 Long", text: "BUTTERFLY", wrap: false },
    { label: "Sentence L4", text: "I LIKE CATS", wrap: true },
    { label: "Sentence L5", text: "WE ARE LEARNING TO TYPE TODAY", wrap: true }
  ];

  return (
    <div className="screen diagnostics">
      <h2>Text Fit Diagnostics</h2>
      <p>Preview and Game should match for the same container size.</p>
      <div className="diagnostics-grid">
        {cases.map((item) => (
          <div className="diagnostics-card" key={item.label}>
            <strong>{item.label}</strong>
            <div className="diagnostics-pair">
              <div className="diagnostics-slot">
                <div className="hint">Preview</div>
                <TaskText
                  text={item.text}
                  config={item.wrap ? sentenceConfig : config}
                  className="task-current-fit"
                  textClassName={item.wrap ? "sentence-text" : undefined}
                  showBounds={settings.showBounds}
                >
                  {renderZeroStyledText(item.text, settings)}
                </TaskText>
              </div>
              <div className="diagnostics-slot">
                <div className="hint">Game</div>
                <TaskText
                  text={item.text}
                  config={item.wrap ? sentenceConfig : config}
                  className="task-current-fit"
                  textClassName={item.wrap ? "sentence-text" : undefined}
                  showBounds={settings.showBounds}
                >
                  {renderZeroStyledText(item.text, settings)}
                </TaskText>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function UXDiagnosticsPage({
  settings,
  contrastReport
}: {
  settings: AppSettings;
  contrastReport: any;
}) {
  const scale = TEXT_SCALE[settings.textSize];
  const config = makeFitConfig({ scale, autoFit: settings.autoFitText, allowWrap: false, variant: "preview" });
  const sentenceConfig = makeFitConfig({ scale: scale * 0.7, autoFit: settings.autoFitText, allowWrap: true, variant: "preview" });
  const baseTheme = computeTheme(settings);
  const effectiveTheme = applyVisibilityGuard(baseTheme, settings.visibilityGuard).theme;
  const [rollingMetrics, setRollingMetrics] = useState<FitMetrics | null>(null);
  const rollingWord = "BUTTERFLY";
  const rollingCaret = 4;
  const avgWidth = rollingMetrics && rollingWord.length ? rollingMetrics.text.width / rollingWord.length : 0;
  const rollingOffset = avgWidth ? avgWidth * rollingCaret : 0;

  const renderProgress = (word: string, caret: number) => (
    <span className="progress-word">
      {word.split("").map((char, idx) => {
        const status = idx < caret ? "correct" : "pending";
        const isCurrent = idx === caret;
        const zeroClass = settings.differentiateZero && char === "0"
          ? settings.zeroStyle === "dotted"
            ? " zero zero-dotted"
            : settings.zeroStyle === "slashed"
              ? " zero zero-slashed"
              : " zero zero-dot"
          : "";
        return (
          <span key={`${word}-${idx}`} className={`char ${status}${isCurrent ? " current" : ""}${zeroClass}`}>
            {char}
          </span>
        );
      })}
    </span>
  );

  return (
    <div className="screen diagnostics ux-diagnostics">
      <h2>UX Diagnostics</h2>
      <p>Theme contrast, control consistency, and typing previews.</p>

      <div className="diagnostics-grid">
        <div className="diagnostics-card">
          <strong>Theme Tokens</strong>
          <div className="token-list">
            {[
              { name: "Background", value: effectiveTheme.background },
              { name: "Surface", value: effectiveTheme.panel },
              { name: "Text", value: effectiveTheme.text },
              { name: "Muted", value: effectiveTheme.mutedText },
              { name: "Accent", value: effectiveTheme.accent },
              { name: "Correct", value: effectiveTheme.correct },
              { name: "Mistake", value: effectiveTheme.mistake }
            ].map((token) => (
              <div key={token.name} className="token-row">
                <span>{token.name}</span>
                <span className="token-swatch" style={{ background: token.value }} />
                <code>{token.value}</code>
              </div>
            ))}
          </div>
        </div>

        <div className="diagnostics-card">
          <strong>Contrast Ratios</strong>
          {(contrastReport?.pairs || []).map((pair: any) => (
            <div key={pair.name} className="contrast-row">
              <div>{pair.name}</div>
              <div className={pair.passAAA ? "pass" : pair.passAA ? "warn" : "fail"}>
                {pair.ratio.toFixed(2)} {pair.passAAA ? "AAA" : pair.passAA ? "AA" : "Fail"}
                {settings.apcaDeveloper && (
                  <span className="apca"> APCA≈{apcaEstimate(pair.fg, pair.bg)}</span>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="diagnostics-card">
          <strong>Control Kit</strong>
          <Stack gap="sm">
            <Group>
              <Switch label="Switch" checked onChange={() => null} />
              <Switch label="Switch disabled" checked disabled onChange={() => null} />
            </Group>
            <Group>
              <Checkbox label="Checkbox" checked onChange={() => null} />
              <Checkbox label="Checkbox disabled" checked disabled onChange={() => null} />
            </Group>
            <SettingSliderRow
              label="Slider"
              value={70}
              min={0}
              max={100}
              step={1}
              onChange={() => null}
              formatValue={(value) => `${value}%`}
            />
            <Select
              label="Select"
              value="a"
              onChange={() => null}
              data={[
                { value: "a", label: "Option A" },
                { value: "b", label: "Option B" }
              ]}
            />
            <SegmentedControl
              value="one"
              onChange={() => null}
              data={[
                { value: "one", label: "One" },
                { value: "two", label: "Two" }
              ]}
            />
            <TextInput label="Text input" value="Sample" readOnly />
            <Group>
              <Button>Primary</Button>
              <Button variant="light">Secondary</Button>
            </Group>
          </Stack>
        </div>

        <div className="diagnostics-card">
          <strong>Typing Preview: Per-Character</strong>
          <div className="diagnostics-slot">
            <TaskText text="HAPPY" config={config}>
              {renderProgress("HAPPY", 2)}
            </TaskText>
          </div>
        </div>

        <div className="diagnostics-card">
          <strong>Typing Preview: Rolling Cart</strong>
          <div className="diagnostics-slot">
            <TaskText text={rollingWord} config={config} onMetrics={setRollingMetrics}>
              <span className="rolling-cart">
                <span
                  className="rolling-track"
                  style={{ transform: `translateX(calc(50% - ${rollingOffset}px))` }}
                >
                  {renderProgress(rollingWord, rollingCaret)}
                </span>
              </span>
            </TaskText>
          </div>
        </div>

        <div className="diagnostics-card">
          <strong>Typing Preview: Space Required</strong>
          <div className="diagnostics-slot">
            <TaskText text="LIKE" config={config}>
              {renderProgress("LIKE", 4)}
            </TaskText>
            <div className="space-hint">Press ␣ Space</div>
          </div>
          <TaskText text="WE LIKE CATS" config={sentenceConfig} className="sentence-fit" textClassName="sentence sentence-text">
            {renderZeroStyledText("WE LIKE CATS", settings)}
          </TaskText>
        </div>
      </div>
    </div>
  );
}

function ControlsDiagnosticsPage({
  settings,
  setSettings
}: {
  settings: AppSettings;
  setSettings: (value: AppSettings | ((prev: AppSettings) => AppSettings)) => void;
}) {
  const [localSpeed, setLocalSpeed] = useState(settings.animationSpeed);
  const [localDuration, setLocalDuration] = useState(settings.correctEffects.durationMs);
  const [localVolume, setLocalVolume] = useState(Math.round(settings.correctEffects.volume * 100));
  const [showSampleModal, setShowSampleModal] = useState(false);

  useEffect(() => setLocalSpeed(settings.animationSpeed), [settings.animationSpeed]);
  useEffect(() => setLocalDuration(settings.correctEffects.durationMs), [settings.correctEffects.durationMs]);
  useEffect(() => setLocalVolume(Math.round(settings.correctEffects.volume * 100)), [settings.correctEffects.volume]);

  return (
    <div className="screen diagnostics">
      <Modal
        opened={showSampleModal}
        onClose={() => setShowSampleModal(false)}
        title="Stop this session?"
        centered
        overlayProps={{ backgroundOpacity: 0.72, blur: 1 }}
        classNames={{
          overlay: "app-modal-overlay",
          content: "app-modal-content",
          header: "app-modal-header",
          title: "app-modal-title",
          body: "app-modal-body",
          close: "app-modal-close"
        }}
      >
        <Text>This is a diagnostics modal preview for contrast and readability checks.</Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="light" onClick={() => setShowSampleModal(false)}>Continue</Button>
          <Button color="red" onClick={() => setShowSampleModal(false)}>Stop session</Button>
        </Group>
      </Modal>
      <h2>Controls Diagnostics</h2>
      <p>Verify select, switch, and slider behavior with persisted values.</p>
      <div className="diagnostics-grid">
        <div className="diagnostics-card">
          <strong>Sliders</strong>
          <SettingSliderRow
            label="Animation speed"
            min={0.5}
            max={1.5}
            step={0.05}
            value={localSpeed}
            onChange={(value) => {
              setLocalSpeed(value);
              setSettings((prev) => ({ ...prev, animationSpeed: value }));
            }}
            formatValue={(value) => `${value.toFixed(2)}x`}
          />
          <SettingSliderRow
            label="Effect duration"
            min={200}
            max={2000}
            step={50}
            value={localDuration}
            onChange={(value) => {
              setLocalDuration(value);
              setSettings((prev) => ({
                ...prev,
                correctEffects: { ...prev.correctEffects, durationMs: value }
              }));
            }}
            formatValue={(value) => `${Math.round(value)} ms`}
          />
          <SettingSliderRow
            label="Volume"
            min={0}
            max={100}
            step={1}
            value={localVolume}
            onChange={(value) => {
              setLocalVolume(value);
              setSettings((prev) => ({
                ...prev,
                correctEffects: { ...prev.correctEffects, volume: value / 100 }
              }));
            }}
            formatValue={(value) => `${Math.round(value)}%`}
          />
          <div className="status">
            Local: {localSpeed.toFixed(2)}x, {Math.round(localDuration)} ms, {localVolume}%<br />
            Persisted: {settings.animationSpeed.toFixed(2)}x, {Math.round(settings.correctEffects.durationMs)} ms, {Math.round(settings.correctEffects.volume * 100)}%
          </div>
          <Button
            variant="light"
            onClick={() => {
              setSettings((prev) => ({
                ...prev,
                animationSpeed: defaultAppSettings.animationSpeed,
                correctEffects: {
                  ...prev.correctEffects,
                  durationMs: defaultAppSettings.correctEffects.durationMs,
                  volume: defaultAppSettings.correctEffects.volume
                }
              }));
            }}
          >
            Reset sliders to defaults
          </Button>
        </div>

        <div className="diagnostics-card">
          <strong>Select & Switch</strong>
          <SettingRow label="Open a sample Select">
            <Select
              value="aa"
              onChange={() => null}
              data={[
                { value: "off", label: "Off" },
                { value: "aa", label: "AA (selected)" },
                { value: "aaa", label: "AAA (disabled)", disabled: true }
              ]}
            />
          </SettingRow>
          <SettingRow label="Select states">
            <Select
              value="aa"
              onChange={() => null}
              data={[
                { value: "off", label: "Off" },
                { value: "aa", label: "AA (selected)" },
                { value: "aaa", label: "AAA (disabled)", disabled: true }
              ]}
            />
          </SettingRow>
          <SettingRow label="Switch states">
            <Group>
              <Switch label="On" checked onChange={() => null} />
              <Switch label="Off" checked={false} onChange={() => null} />
              <Switch label="Disabled" checked disabled onChange={() => null} />
            </Group>
          </SettingRow>
          <Group justify="flex-start">
            <Button variant="light" onClick={() => setShowSampleModal(true)}>Open Stop-session modal</Button>
          </Group>
        </div>
      </div>
    </div>
  );
}

function TestPlayground({
  settings,
  onUpdateSettings
}: {
  settings: AppSettings;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
}) {
  const [mode, setMode] = useState<"single" | "short" | "long" | "sentence_short" | "sentence_long">("single");
  const [sampleIndex, setSampleIndex] = useState(0);
  const [buffer, setBuffer] = useState("");
  const [caretIndex, setCaretIndex] = useState(0);
  const [progress, setProgress] = useState<Array<"correct" | "wrong" | "pending">>([]);
  const [expectSpace, setExpectSpace] = useState(false);
  const [wordIndex, setWordIndex] = useState(0);
  const [showEffects, setShowEffects] = useState(false);
  const [effectTick, setEffectTick] = useState(0);
  const [effectSeed, setEffectSeed] = useState(1);
  const [mistakeFlash, setMistakeFlash] = useState(false);
  const [fitMetrics, setFitMetrics] = useState<FitMetrics | null>(null);
  const [functionKeyNotice, setFunctionKeyNotice] = useState("");
  const [lastFunctionKey, setLastFunctionKey] = useState("");
  const [lastFunctionKeyTime, setLastFunctionKeyTime] = useState(0);
  const [showZeroHint, setShowZeroHint] = useState(false);

  const intensity = settings.lowStimulation ? "very_low" : settings.correctEffects.intensity;
  const sound = useSoundBank(settings.correctEffects.volume * INTENSITY_CONFIG[intensity].volume, !settings.soundEnabled);

  const samples = {
    single: ["A", "K", "5"],
    short: ["cat", "sun", "bee"],
    long: ["monkey", "rabbit", "rocket"],
    sentence_short: ["I LIKE CATS", "THE RED BALL", "A HAPPY DOG"],
    sentence_long: ["WE ARE LEARNING TO TYPE TODAY", "THE HAPPY LITTLE CAT JUMPS"]
  };

  const sentence = samples[mode][sampleIndex % samples[mode].length];
  const words = mode.startsWith("sentence") ? sentence.split(" ") : [];
  const prompt = mode.startsWith("sentence") ? words[wordIndex] || words[0] : sentence;

  const textScale = TEXT_SCALE[settings.textSize];
  const config = makeFitConfig({ scale: textScale, autoFit: settings.autoFitText, allowWrap: false, variant: "current" });
  const sentenceConfig = makeFitConfig({ scale: textScale * 0.6, autoFit: settings.autoFitText, allowWrap: true, variant: "preview" });

  const sampleTask: Task = {
    id: `test-${mode}-${sampleIndex}-${wordIndex}`,
    level: mode === "single" ? 1 : mode === "short" ? 2 : mode === "long" ? 3 : mode === "sentence_short" ? 4 : 5,
    prompt,
    answer: prompt,
    sentence: mode.startsWith("sentence") ? sentence : undefined,
    words: mode.startsWith("sentence") ? words : undefined,
    wordIndex: mode.startsWith("sentence") ? wordIndex : undefined
  };
  const triggerCorrect = useCallback(() => {
    const duration = Math.max(250, settings.correctEffects.durationMs / settings.animationSpeed);
    const soundChoice = settings.correctEffects.randomizeSound
      ? SOUND_OPTIONS[Math.floor(Math.random() * SOUND_OPTIONS.length)]
      : settings.correctEffects.sound;
    sound.play(soundChoice);
    setEffectSeed(settings.correctEffects.variation === "same" ? 7 : Date.now());
    setEffectTick((prev) => prev + 1);
    setShowEffects(true);
    setTimeout(() => setShowEffects(false), duration);
  }, [
    settings.correctEffects.durationMs,
    settings.correctEffects.randomizeSound,
    settings.correctEffects.sound,
    settings.correctEffects.variation,
    settings.animationSpeed,
    sound
  ]);

  useEffect(() => {
    setBuffer("");
    setCaretIndex(0);
    setExpectSpace(false);
    setWordIndex(0);
    setProgress(Array.from({ length: prompt.length }, () => "pending"));
  }, [mode, sampleIndex, prompt]);

  useEffect(() => {
    const shown = localStorage.getItem("zero_hint_shown") === "1";
    setShowZeroHint(!shown);
  }, []);

  useEffect(() => {
    if (!functionKeyNotice) return;
    const id = window.setTimeout(() => setFunctionKeyNotice(""), 2500);
    return () => window.clearTimeout(id);
  }, [functionKeyNotice]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.closest("input, textarea, select, [contenteditable=\"true\"]")) return;
      const key = event.key;
      const kind = classifyKey(event);

      if (kind === "function" && settings.protectFunctionKeys) {
        const now = Date.now();
        if (lastFunctionKey === key && now - lastFunctionKeyTime < 3000) {
          setFunctionKeyNotice("");
          setLastFunctionKey("");
          setLastFunctionKeyTime(0);
          return;
        }
        event.preventDefault();
        setLastFunctionKey(key);
        setLastFunctionKeyTime(now);
        setFunctionKeyNotice("Function key pressed. Press again to use it.");
        return;
      }

      if (kind === "modifier" || kind === "navigation" || kind === "other") return;
      if (kind === "punct") return;
      if (kind === "space" && !expectSpace) return;

      const normalized = key.toLowerCase();

      if (expectSpace) {
        if (key === " ") {
          setExpectSpace(false);
          if (mode.startsWith("sentence")) {
            const nextIndex = wordIndex + 1;
            if (nextIndex < words.length) {
              setWordIndex(nextIndex);
              setCaretIndex(0);
              setBuffer("");
              setProgress(Array.from({ length: (words[nextIndex] || "").length }, () => "pending"));
            } else {
              triggerCorrect();
              setWordIndex(0);
              setCaretIndex(0);
              setBuffer("");
              setProgress(Array.from({ length: (words[0] || "").length }, () => "pending"));
            }
          }
        } else {
          setMistakeFlash(true);
          setTimeout(() => setMistakeFlash(false), 300);
        }
        return;
      }

      const expected = sampleTask.answer.toLowerCase();
      const expectedChar = expected[caretIndex];
      if (!expectedChar) return;

      if (normalized === expectedChar) {
        setBuffer((prev) => prev + normalized);
        setProgress((prev) => {
          const next = [...prev];
          next[caretIndex] = "correct";
          return next;
        });
        const nextCaret = caretIndex + 1;
        if (nextCaret >= expected.length) {
          triggerCorrect();
          if (mode.startsWith("sentence") && settings.spaceRequired) {
            setExpectSpace(true);
          } else if (mode.startsWith("sentence")) {
            const nextIndex = wordIndex + 1;
            if (nextIndex < words.length) {
              setWordIndex(nextIndex);
              setCaretIndex(0);
              setBuffer("");
              setProgress(Array.from({ length: (words[nextIndex] || "").length }, () => "pending"));
            } else {
              setWordIndex(0);
              setCaretIndex(0);
              setBuffer("");
              setProgress(Array.from({ length: (words[0] || "").length }, () => "pending"));
            }
          } else {
            setCaretIndex(0);
            setBuffer("");
            setProgress(Array.from({ length: expected.length }, () => "pending"));
          }
        } else {
          setCaretIndex(nextCaret);
        }
      } else {
        setMistakeFlash(true);
        setTimeout(() => setMistakeFlash(false), 300);
        setProgress((prev) => {
          const next = [...prev];
          next[caretIndex] = "wrong";
          return next;
        });
        setTimeout(() => {
          setProgress((prev) => {
            const next = [...prev];
            if (next[caretIndex] === "wrong") next[caretIndex] = "pending";
            return next;
          });
        }, 350);
        if (settings.wrongCharBehavior === "skip") {
          const nextCaret = caretIndex + 1;
          if (nextCaret >= expected.length) {
            if (mode.startsWith("sentence") && settings.spaceRequired) {
              setExpectSpace(true);
            } else if (mode.startsWith("sentence")) {
              const nextIndex = wordIndex + 1;
              if (nextIndex < words.length) {
                setWordIndex(nextIndex);
                setCaretIndex(0);
                setBuffer("");
                setProgress(Array.from({ length: (words[nextIndex] || "").length }, () => "pending"));
              }
            } else {
              setCaretIndex(0);
              setBuffer("");
              setProgress(Array.from({ length: expected.length }, () => "pending"));
            }
          } else {
            setCaretIndex(nextCaret);
          }
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    sampleTask.answer,
    caretIndex,
    expectSpace,
    mode,
    settings.spaceRequired,
    settings.wrongCharBehavior,
    settings.protectFunctionKeys,
    wordIndex,
    words,
    triggerCorrect,
    lastFunctionKey,
    lastFunctionKeyTime
  ]);

  const triggerMistake = () => {
    if (settings.mistakeStyle === "normal") {
      sound.play("pop");
    }
    setMistakeFlash(true);
    setTimeout(() => setMistakeFlash(false), 400);
  };

  const playSound = () => {
    const soundChoice = settings.correctEffects.randomizeSound
      ? SOUND_OPTIONS[Math.floor(Math.random() * SOUND_OPTIONS.length)]
      : settings.correctEffects.sound;
    sound.play(soundChoice);
  };

  return (
    <div className="test-playground">
      <div className="playground-controls">
        <SettingRow label="Preview mode" helper="Switch task type for testing.">
          <SegmentedControl
            value={mode}
            onChange={(value) => setMode(value as typeof mode)}
            data={[
              { value: "single", label: "Single" },
              { value: "short", label: "Short word" },
              { value: "long", label: "Long word" },
              { value: "sentence_short", label: "Sentence short" },
              { value: "sentence_long", label: "Sentence long" }
            ]}
          />
        </SettingRow>

        <SettingRow label="Behavior preview" helper="Toggle real gameplay rules.">
          <Group>
            <Switch
              label="Per-character"
              checked={settings.perCharProgress}
              onChange={(e) => onUpdateSettings({ perCharProgress: e.currentTarget.checked })}
            />
            <Switch
              label="Rolling cart"
              checked={settings.rollingCart === "on"}
              onChange={(e) => onUpdateSettings({ rollingCart: e.currentTarget.checked ? "on" : "off" })}
            />
            <Switch
              label="Space required"
              checked={settings.spaceRequired}
              onChange={(e) => onUpdateSettings({ spaceRequired: e.currentTarget.checked })}
            />
          </Group>
        </SettingRow>

        <SettingRow label="Examples" helper="Cycle the sample content.">
          <Group>
            <Button variant="light" onClick={() => setSampleIndex((i) => i + 1)}>Next example</Button>
          </Group>
        </SettingRow>

        <SettingRow label="Effects preview" helper="Test visual and audio feedback.">
          <Group>
            <Button onClick={triggerCorrect}>Trigger correct</Button>
            <Button variant="light" onClick={triggerMistake}>Trigger mistake</Button>
            <Button variant="light" onClick={playSound}>Play sound</Button>
          </Group>
        </SettingRow>
      </div>

      <div className={"test-display" + (mistakeFlash ? " mistake" : "")}>
        {functionKeyNotice && (
          <FunctionKeyBanner message={functionKeyNotice} onDismiss={() => setFunctionKeyNotice("")} />
        )}
        {showZeroHint && settings.differentiateZero && /[0O]/.test(sampleTask.prompt) && (
          <ZeroHintBanner
            onDismiss={() => {
              setShowZeroHint(false);
              localStorage.setItem("zero_hint_shown", "1");
            }}
          />
        )}
        <TaskStage
          currentTask={sampleTask}
          fitConfigCurrent={config}
          fitConfigSentence={sentenceConfig}
          appSettings={settings}
          correctFlash={false}
          mistakeFlash={mistakeFlash}
          buffer={buffer}
          progress={progress}
          caretIndex={caretIndex}
          expectSpace={expectSpace}
          fitMetrics={fitMetrics}
          onMetrics={setFitMetrics}
        />
        {settings.debugLayout && fitMetrics && (
          <div className="playground-debug">
            <div><strong>Container</strong>: {Math.round(fitMetrics.container.width)}×{Math.round(fitMetrics.container.height)}</div>
            <div><strong>Font</strong>: {Math.round(fitMetrics.fontSize)}px</div>
            <div><strong>Text</strong>: {Math.round(fitMetrics.text.width)}×{Math.round(fitMetrics.text.height)}</div>
          </div>
        )}
      </div>

      <CorrectEffects
        show={showEffects}
        tick={effectTick}
        seed={effectSeed}
        settings={settings}
        intensity={intensity}
      />
    </div>
  );
}

export default App;
