import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type PublicUser } from "../../api";

export type LeaderRow = {
  rank: number;
  displayName: string;
  username: string;
  score: number;
};

export function useGameSession<TSave>(gameId: string) {
  const [player, setPlayer] = useState<PublicUser | null>(null);
  const [highScore, setHighScore] = useState<number | null>(null);
  const [board, setBoard] = useState<LeaderRow[]>([]);
  const [save, setSave] = useState<TSave | null>(null);
  const [restored, setRestored] = useState(false);
  /** 存档请求已完成（无论有没有档）：游戏必须等它为 true 才能应用存档/接收输入 */
  const [saveSettled, setSaveSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reloadBoard = useCallback(async () => {
    const scores = await api<{ ranking: LeaderRow[]; myScore?: number | null }>(`/api/scores/${gameId}`);
    setBoard(scores.ranking);
    return scores;
  }, [gameId]);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      try {
        await api("/api/auth/verify");
        const me = await api<{ user: PublicUser }>("/api/auth/me");
        if (cancelled) return;
        setPlayer(me.user);
        const scoresRes = await reloadBoard();
        if (cancelled) return;
        // 本人最佳由服务端直接返回；从 Top-20 里找自己，挤不进前 20 会误判成「无成绩」
        setHighScore(typeof scoresRes.myScore === "number" ? scoresRes.myScore : null);
        const saveRes = await api<{ save: TSave | null }>(`/api/saves/${gameId}`);
        if (cancelled) return;
        if (saveRes.save) {
          setSave(saveRes.save);
          setRestored(true);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "未授权，无法进入游戏");
      } finally {
        if (!cancelled) setSaveSettled(true);
      }
    }
    void boot();
    return () => {
      cancelled = true;
    };
  }, [gameId, reloadBoard]);

  const submitScore = useCallback(
    async (score: number) => {
      const result = await api<{ highScore: number; isNewHigh: boolean }>(`/api/scores/${gameId}`, {
        method: "POST",
        body: JSON.stringify({ score }),
      });
      setHighScore(result.highScore);
      await reloadBoard();
      return result;
    },
    [gameId, reloadBoard],
  );

  const persistSave = useCallback(
    async (data: TSave) => {
      await api(`/api/saves/${gameId}`, {
        method: "PUT",
        body: JSON.stringify({ data }),
      });
    },
    [gameId],
  );

  const submitRef = useRef(submitScore);
  const persistRef = useRef(persistSave);
  submitRef.current = submitScore;
  persistRef.current = persistSave;

  const submitStable = useCallback((score: number) => submitRef.current(score), []);
  const persistStable = useCallback((data: TSave) => persistRef.current(data), []);

  return useMemo(
    () => ({
      player,
      highScore,
      board,
      save,
      saveSettled,
      restored,
      error,
      submitScore: submitStable,
      persistSave: persistStable
    }),
    [player, highScore, board, save, saveSettled, restored, error, submitStable, persistStable]
  );
}
