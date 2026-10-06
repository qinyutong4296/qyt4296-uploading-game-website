import React, { useState } from "react";
import { cloud } from "./cloud";
import { errMsg } from "./api";
import styles from "../styles/modules/group-2.module.css";

type Tab = "password" | "otp" | "forgot";

type PendingOtp = { email: string; verificationId: string; isExistingUser: boolean } | null;

export default function AdminLoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [tab, setTab] = useState<Tab>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [pending, setPending] = useState<PendingOtp>(null);
  const [forgotChallenge, setForgotChallenge] = useState<{ updateUser: (p: { nonce: string; password: string }) => Promise<{ error: unknown }> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [countdown, setCountdown] = useState(0);

  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  function startCountdown() {
    setCountdown(60);
    const timer = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(timer);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  }

  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  const submitPassword = (e: React.FormEvent) =>
    void run(async () => {
      e.preventDefault();
      if (!validEmail || !password) {
        setMsg({ kind: "err", text: "请输入邮箱和密码" });
        return;
      }
      const { error } = await cloud.auth.signInWithPassword({ email: email.trim(), password });
      if (error) {
        setMsg({ kind: "err", text: "账号或密码错误" });
        return;
      }
      onLoggedIn();
    });

  const sendCode = () =>
    void run(async () => {
      if (!validEmail) {
        setMsg({ kind: "err", text: "请输入正确的邮箱地址" });
        return;
      }
      const sent = await cloud.auth.sendOtp({ email: email.trim() });
      if (sent.error) {
        setMsg({ kind: "err", text: errMsg(sent.error, "验证码发送失败") });
        return;
      }
      setPending({
        email: email.trim(),
        verificationId: sent.data.verificationId,
        isExistingUser: sent.data.isExistingUser,
      });
      setMsg({ kind: "ok", text: "验证码已发送,请查收邮箱" });
      startCountdown();
    });

  const submitOtp = (e: React.FormEvent) =>
    void run(async () => {
      e.preventDefault();
      if (!pending || pending.email !== email.trim()) {
        setMsg({ kind: "err", text: "请先获取当前邮箱的验证码" });
        return;
      }
      if (!pending.isExistingUser && newPassword.length < 8) {
        setMsg({ kind: "err", text: "首次注册需设置至少 8 位密码" });
        return;
      }
      const completed = await cloud.auth.verifyOtp({
        email: pending.email,
        verificationId: pending.verificationId,
        isExistingUser: pending.isExistingUser,
        token: code.trim(),
        password: pending.isExistingUser ? undefined : newPassword,
      });
      if (completed.error) {
        setMsg({ kind: "err", text: "验证码不正确或已过期" });
        return;
      }
      setPending(null);
      onLoggedIn();
    });

  const startForgot = () =>
    void run(async () => {
      if (!validEmail) {
        setMsg({ kind: "err", text: "请输入正确的邮箱地址" });
        return;
      }
      const started = await cloud.auth.resetPasswordForEmail(email.trim());
      if (started.error) {
        setMsg({ kind: "err", text: errMsg(started.error, "发送失败") });
        return;
      }
      setForgotChallenge(started.data as typeof forgotChallenge);
      setMsg({ kind: "ok", text: "重置验证码已发送到邮箱" });
      startCountdown();
    });

  const submitForgot = (e: React.FormEvent) =>
    void run(async () => {
      e.preventDefault();
      if (!forgotChallenge) {
        setMsg({ kind: "err", text: "请先发送重置验证码" });
        return;
      }
      if (newPassword.length < 8) {
        setMsg({ kind: "err", text: "新密码至少 8 位" });
        return;
      }
      const completed = await forgotChallenge.updateUser({ nonce: code.trim(), password: newPassword });
      if (completed.error) {
        setMsg({ kind: "err", text: "重置失败,验证码可能不正确" });
        return;
      }
      setMsg({ kind: "ok", text: "密码已重置,正在进入…" });
      onLoggedIn();
    });

  return (
    <div className={`${styles.root} ${styles.loginWrap}`}>
      <div className={styles.loginCard}>
        <div className={styles.loginBrand}>
          <span className={styles.loginLogo}>游</span>
          <div>
            <h1>小游戏合集 · 管理后台</h1>
            <p className={styles.muted}>云端管理系统 · 仅限授权管理员</p>
          </div>
        </div>

        <div className={styles.tabs}>
          <button type="button" className={tab === "password" ? styles.tabActive : ""} onClick={() => { setTab("password"); setMsg(null); }}>
            密码登录
          </button>
          <button type="button" className={tab === "otp" ? styles.tabActive : ""} onClick={() => { setTab("otp"); setMsg(null); }}>
            验证码登录/注册
          </button>
          <button type="button" className={tab === "forgot" ? styles.tabActive : ""} onClick={() => { setTab("forgot"); setMsg(null); }}>
            忘记密码
          </button>
        </div>

        <label className={styles.field}>
          <span>邮箱</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@example.com"
            autoComplete="email"
          />
        </label>

        {tab === "password" && (
          <form onSubmit={submitPassword}>
            <label className={styles.field}>
              <span>密码</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入密码"
                autoComplete="current-password"
              />
            </label>
            <button className={styles.primaryBtn} type="submit" disabled={busy}>
              {busy ? "登录中…" : "登 录"}
            </button>
          </form>
        )}

        {tab === "otp" && (
          <form onSubmit={submitOtp}>
            <label className={styles.field}>
              <span>邮箱验证码</span>
              <div className={styles.codeRow}>
                <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="6 位验证码" inputMode="numeric" />
                <button type="button" className={styles.ghostBtn} onClick={sendCode} disabled={busy || countdown > 0}>
                  {countdown > 0 ? `${countdown}s 后重发` : pending ? "重新获取" : "获取验证码"}
                </button>
              </div>
            </label>
            {pending && !pending.isExistingUser && (
              <label className={styles.field}>
                <span>设置密码(首次注册,至少 8 位)</span>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="用于以后密码登录"
                  autoComplete="new-password"
                />
              </label>
            )}
            <button className={styles.primaryBtn} type="submit" disabled={busy}>
              {busy ? "验证中…" : "登录 / 注册"}
            </button>
          </form>
        )}

        {tab === "forgot" && (
          <form onSubmit={submitForgot}>
            <label className={styles.field}>
              <span>邮箱验证码</span>
              <div className={styles.codeRow}>
                <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="6 位验证码" inputMode="numeric" />
                <button type="button" className={styles.ghostBtn} onClick={startForgot} disabled={busy || countdown > 0}>
                  {countdown > 0 ? `${countdown}s 后重发` : "发送验证码"}
                </button>
              </div>
            </label>
            <label className={styles.field}>
              <span>新密码(至少 8 位)</span>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
              />
            </label>
            <button className={styles.primaryBtn} type="submit" disabled={busy}>
              {busy ? "提交中…" : "重置密码并登录"}
            </button>
          </form>
        )}

        {msg && <p className={msg.kind === "ok" ? styles.okMsg : styles.errMsg}>{msg.text}</p>}
        <p className={styles.muted} style={{ marginTop: 16, fontSize: 12 }}>
          提示:系统首个登录的账号可认领为初始管理员,之后仅管理员可进入后台。
        </p>
      </div>
    </div>
  );
}
