import React, { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { cloud, db } from "../cloud";
import { errMsg, logAudit } from "../api";
import { useAdminAuth } from "../AdminAuth";
import type { GameRow } from "../types";
import styles from "../../styles/modules/group-2.module.css";

const CATEGORIES = ["经典", "益智", "解谜", "动作", "休闲", "策略", "其他"];
const MAX_COVER_SIZE = 2 * 1024 * 1024;
const COVER_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export default function GameEditPage() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const { user } = useAdminAuth();

  const [form, setForm] = useState({
    slug: "",
    title: "",
    description: "",
    category: "休闲",
    play_url: "",
    sort_order: 0,
    status: "published" as "published" | "hidden",
  });
  const [coverPath, setCoverPath] = useState<string | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!isNew);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    if (isNew) return;
    let mounted = true;
    (async () => {
      try {
        const { data, error } = await db.from("games").select("*").eq("id", Number(id)).maybeSingle();
        if (error) throw error;
        if (!data) {
          setMsg({ kind: "err", text: "游戏不存在或没有查看权限" });
          return;
        }
        const g = data as GameRow;
        if (!mounted) return;
        setForm({
          slug: g.slug,
          title: g.title,
          description: g.description,
          category: g.category,
          play_url: g.play_url ?? "",
          sort_order: g.sort_order,
          status: g.status,
        });
        setCoverPath(g.cover_path);
        if (g.cover_path) {
          try {
            const signed = await cloud.storage.createSignedUrl(g.cover_path, 600);
            const url = (signed as { data?: { signedUrl?: string; url?: string } }).data;
            if (mounted && url) setCoverPreview(url.signedUrl ?? url.url ?? null);
          } catch {
            /* 封面预览失败不影响编辑 */
          }
        }
      } catch (e) {
        if (mounted) setMsg({ kind: "err", text: errMsg(e, "加载失败") });
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [id, isNew]);

  function pick<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function onCoverChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setMsg(null);
    if (!file) return;
    if (!COVER_TYPES[file.type]) {
      setMsg({ kind: "err", text: "封面仅支持 PNG / JPG / WebP 图片" });
      return;
    }
    if (file.size > MAX_COVER_SIZE) {
      setMsg({ kind: "err", text: "封面大小不能超过 2MB" });
      return;
    }
    setCoverFile(file);
    setCoverPreview(URL.createObjectURL(file));
  }

  async function uploadCover(): Promise<string | null> {
    if (!coverFile || !user) return coverPath;
    const ext = COVER_TYPES[coverFile.type];
    const path = cloud.storage.sharedPath(user.id, `covers/${crypto.randomUUID()}.${ext}`);
    const { error } = await cloud.storage.upload(path, coverFile, {
      contentType: coverFile.type,
      cacheControl: "86400",
      upsert: false,
    });
    if (error) throw error;
    return path;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setMsg(null);

    const slug = form.slug.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-_]{1,31}$/.test(slug)) {
      setMsg({ kind: "err", text: "标识(slug)需为 2-32 位小写字母/数字/中划线" });
      return;
    }
    if (!form.title.trim()) {
      setMsg({ kind: "err", text: "请填写游戏名称" });
      return;
    }

    setBusy(true);
    try {
      const finalCover = await uploadCover();
      const payload = {
        slug,
        title: form.title.trim(),
        description: form.description.trim(),
        category: form.category,
        play_url: form.play_url.trim() || null,
        sort_order: Number(form.sort_order) || 0,
        status: form.status,
        cover_path: finalCover,
        updated_at: new Date().toISOString(),
      };

      if (isNew) {
        const { data, error } = await db.from("games").insert(payload).select();
        if (error) throw error;
        if (!data || data.length === 0) {
          setMsg({ kind: "err", text: "没有权限新增游戏" });
          return;
        }
        await logAudit("create_game", slug, { title: payload.title });
      } else {
        const { data, error } = await db
          .from("games")
          .update(payload)
          .eq("id", Number(id))
          .select();
        if (error) throw error;
        if (!data || data.length === 0) {
          setMsg({ kind: "err", text: "没有权限修改该游戏" });
          return;
        }
        await logAudit("update_game", slug, { title: payload.title });
      }
      navigate("/admin/games");
    } catch (err) {
      setMsg({ kind: "err", text: errMsg(err) });
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className={styles.loading}>加载中…</div>;

  return (
    <div className={styles.panel}>
      <form onSubmit={(e) => void submit(e)}>
        <div className={styles.formGrid}>
          <label className={styles.field}>
            <span>游戏标识 slug(唯一,用于链接)</span>
            <input
              value={form.slug}
              onChange={(e) => pick("slug", e.target.value)}
              placeholder="如 snake"
              disabled={!isNew}
            />
          </label>
          <label className={styles.field}>
            <span>游戏名称 *</span>
            <input value={form.title} onChange={(e) => pick("title", e.target.value)} placeholder="如 贪吃蛇" />
          </label>
          <label className={styles.field}>
            <span>分类</span>
            <select value={form.category} onChange={(e) => pick("category", e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span>状态</span>
            <select value={form.status} onChange={(e) => pick("status", e.target.value as "published" | "hidden")}>
              <option value="published">上架</option>
              <option value="hidden">下架</option>
            </select>
          </label>
          <label className={styles.field}>
            <span>游玩链接(可选)</span>
            <input value={form.play_url} onChange={(e) => pick("play_url", e.target.value)} placeholder="/play/snake 或 https://…" />
          </label>
          <label className={styles.field}>
            <span>排序值(越小越靠前)</span>
            <input
              type="number"
              value={form.sort_order}
              onChange={(e) => pick("sort_order", Number(e.target.value))}
            />
          </label>
          <label className={`${styles.field} ${styles.formFull}`}>
            <span>游戏简介</span>
            <textarea value={form.description} onChange={(e) => pick("description", e.target.value)} placeholder="一句话介绍玩法…" />
          </label>
          <div className={`${styles.field} ${styles.formFull}`}>
            <span>封面图(PNG/JPG/WebP,≤ 2MB,上传至云端存储)</span>
            {coverPreview && <img className={styles.coverPreview} src={coverPreview} alt="封面预览" />}
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={onCoverChange} />
          </div>
        </div>

        {msg && <p className={msg.kind === "ok" ? styles.okMsg : styles.errMsg}>{msg.text}</p>}

        <div className={styles.formActions}>
          <button className={styles.primaryBtn} type="submit" disabled={busy}>
            {busy ? "保存中…" : isNew ? "创建游戏" : "保存修改"}
          </button>
          <Link to="/admin/games">
            <button type="button" className={styles.ghostBtn}>返回列表</button>
          </Link>
        </div>
      </form>
    </div>
  );
}
