import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import JSZip from "jszip";
import { api, apiUpload, openUserUploadedGame } from "../api";
import { useAuth } from "../auth/AuthContext";
import styles from "../styles/modules/group-4.module.css";

type Mine = {
  id: string;
  name: string;
  description: string;
  cover: string;
  entryFile?: string;
  playUrl?: string;
  openHow?: string;
  needsBackend?: boolean;
  createdAt: string;
};

type ProgressState = {
  phase: "idle" | "collect" | "compress" | "upload" | "done";
  percent: number;
  detail: string;
};

const SKIP_DIR =
  /(?:^|\/)(?:node_modules|\.git|__MACOSX|\.svn|\.idea|\.vscode|coverage|\.next|dist\/node_modules|\.cache|tmp|temp)(?:\/|$)/i;

function folderLabel(files: File[]) {
  if (!files.length) return "";
  const rel = files[0].webkitRelativePath || "";
  return rel.split("/")[0] || files[0].name;
}

function shouldKeep(rel: string) {
  const norm = rel.replace(/\\/g, "/");
  if (!norm || SKIP_DIR.test(norm)) return false;
  if (norm.endsWith(".DS_Store") || norm.endsWith("Thumbs.db")) return false;
  return true;
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function UploadPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mine, setMine] = useState<Mine[]>([]);
  const [progress, setProgress] = useState<ProgressState>({
    phase: "idle",
    percent: 0,
    detail: ""
  });

  function loadMine() {
    api<{ games: Mine[] }>("/api/workshop/mine")
      .then((d) => setMine(d.games))
      .catch(() => undefined);
  }

  useEffect(() => {
    loadMine();
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!files.length) {
      setError("请选择整个游戏文件夹");
      return;
    }
    setBusy(true);
    setProgress({ phase: "collect", percent: 0, detail: "正在读取文件…" });
    try {
      const keepers = files.filter((f) =>
        shouldKeep((f.webkitRelativePath || f.name).replace(/\\/g, "/"))
      );
      if (!keepers.length) {
        setError("文件夹里没有可上传的文件（请勿只选 node_modules 等目录）");
        setBusy(false);
        setProgress({ phase: "idle", percent: 0, detail: "" });
        return;
      }

      // 0–45%：收集文件；45–70%：压缩；70–100%：上传
      const zip = new JSZip();
      const total = keepers.length;
      for (let i = 0; i < total; i++) {
        const file = keepers[i];
        const rel = (file.webkitRelativePath || file.name).replace(/\\/g, "/");
        zip.file(rel, await file.arrayBuffer());
        if (i % 8 === 0 || i === total - 1) {
          const pct = Math.round(((i + 1) / total) * 45);
          setProgress({
            phase: "collect",
            percent: pct,
            detail: `打包文件 ${i + 1} / ${total}`
          });
        }
      }

      setProgress({ phase: "compress", percent: 45, detail: "正在压缩…" });
      const blob = await zip.generateAsync(
        { type: "blob", compression: "DEFLATE" },
        (meta) => {
          const pct = 45 + Math.round((meta.percent / 100) * 25);
          setProgress({
            phase: "compress",
            percent: Math.min(70, pct),
            detail: `压缩中 ${Math.round(meta.percent)}%`
          });
        }
      );

      const body = new FormData();
      body.append("title", title);
      body.append("description", description);
      body.append(
        "files",
        new File([blob], `${folderLabel(files) || "game"}.zip`, { type: "application/zip" })
      );

      setProgress({
        phase: "upload",
        percent: 70,
        detail: `开始上传（${formatBytes(blob.size)}）…`
      });

      const res = await apiUpload<{
        game: {
          id: string;
          name: string;
          playUrl?: string;
          entryFile?: string;
          needsBackend?: boolean;
        };
      }>("/api/workshop", body, (p) => {
        const pct = 70 + Math.round((p.percent / 100) * 30);
        setProgress({
          phase: "upload",
          percent: Math.min(99, pct),
          detail: `上传中 ${formatBytes(p.loaded)} / ${formatBytes(p.total)}`
        });
      });

      // 上传已成功：先刷新列表，再尝试打开（打开失败不应看起来像上传失败）
      setTitle("");
      setDescription("");
      setFiles([]);
      loadMine();

      setProgress({
        phase: "done",
        percent: 100,
        detail: res.game.needsBackend
          ? "发布成功，正在安装依赖并启动服务（首次约 1–3 分钟）…"
          : "发布成功，正在进入游戏…"
      });
      try {
        await openUserUploadedGame(
          {
            id: res.game.id,
            playUrl: res.game.playUrl,
            entryFile: res.game.entryFile,
            needsBackend: res.game.needsBackend
          },
          navigate
        );
        return;
      } catch (openErr) {
        setError(
          `「${res.game.name}」已发布成功，但自动打开失败：${
            openErr instanceof Error ? openErr.message : "未知错误"
          }。请稍后再点「打开游戏页」（依赖可能仍在后台安装）。`
        );
      }
      setBusy(false);
      setProgress({ phase: "idle", percent: 0, detail: "" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "上传失败");
      setBusy(false);
      setProgress({ phase: "idle", percent: 0, detail: "" });
      loadMine();
    }
  }

  async function remove(id: string) {
    if (!confirm("确定永久删除该游戏？将清除全部文件、收藏、存档、积分及相关痕迹，不可恢复。")) return;
    try {
      await api(`/api/workshop/${id}`, { method: "DELETE" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
      return;
    }
    loadMine();
  }

  const phaseLabel =
    progress.phase === "collect"
      ? "读取打包"
      : progress.phase === "compress"
        ? "压缩"
        : progress.phase === "upload"
          ? "上传"
          : progress.phase === "done"
            ? "完成"
            : "";

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <div className={styles.title}>
          <i />
          上传小游戏
        </div>
        <span className="muted">{user?.displayName}</span>
      </div>
      <p className="muted">
        请上传<strong>整个游戏文件夹</strong>。系统会自动识别入口页（如 <code>index.html</code> /{" "}
        <code>main.html</code> / <code>game.html</code> / <code>dist/index.html</code> 等），并把
        <strong>打开方式</strong>显示在大厅首页。发布后直接进入游戏页。
      </p>
      {error && <div className="banner">{error}</div>}
      <form onSubmit={onSubmit} style={{ display: "grid", gap: 12, maxWidth: 520 }}>
        <label>
          游戏名称
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="2-40 个字"
            disabled={busy}
          />
        </label>
        <label>
          简介
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={busy}
          />
        </label>
        <label>
          游戏文件夹
          <input
            type="file"
            multiple
            disabled={busy}
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            onChange={(e) => setFiles(Array.from(e.target.files || []))}
          />
        </label>
        {files.length > 0 && (
          <p className="muted" style={{ margin: 0 }}>
            已选「{folderLabel(files)}」，共 {files.length} 个文件（将打包后上传，自动跳过 node_modules 等）
          </p>
        )}
        {busy && (
          <div className={styles.uploadProgress} aria-live="polite">
            <div className={styles.uploadProgressHead}>
              <span>
                {phaseLabel}
                {progress.detail ? ` · ${progress.detail}` : ""}
              </span>
              <strong>{progress.percent}%</strong>
            </div>
            <div className={styles.uploadProgressTrack} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}>
              <div className={styles.uploadProgressBar} style={{ width: `${progress.percent}%` }} />
            </div>
          </div>
        )}
        <button type="submit" disabled={busy}>
          {busy ? "正在打包上传…" : "发布到工坊"}
        </button>
      </form>
      <h3 style={{ marginTop: 28 }}>我上传的游戏</h3>
      <div className={styles.grid}>
        {mine.map((g) => (
          <div key={g.id} className={styles.card}>
            <strong>{g.name}</strong>
            <p className="muted" style={{ margin: 0 }}>
              {g.description}
            </p>
            <div className={styles.openHow}>打开方式：{g.openHow || g.entryFile || "index.html"}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() =>
                  openUserUploadedGame(
                    {
                      id: g.id,
                      playUrl: g.playUrl,
                      entryFile: g.entryFile,
                      needsBackend: g.needsBackend
                    },
                    navigate
                  ).catch((err) =>
                    setError(err instanceof Error ? err.message : "无法启动该游戏")
                  )
                }
              >
                打开游戏页
              </button>
              <button className="danger" type="button" onClick={() => remove(g.id)}>
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
      {mine.length === 0 && (
        <p className="muted">
          还没有作品。<Link to="/workshop">去工坊看看别人的</Link>
        </p>
      )}
    </div>
  );
}
