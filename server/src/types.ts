export type PublicUser = {
  id: number;
  username: string;
  displayName: string;
  avatar: string;
  createdAt: string;
  lastLoginAt: string | null;
  isAdmin: boolean;
};

export type JwtPayload = {
  userId: number;
  username: string;
};

export type GameMeta = {
  id: string;
  name: string;
  description: string;
};

export const GAMES: GameMeta[] = [
  { id: "snake", name: "贪吃蛇", description: "经典贪吃蛇，吃到食物变长，撞墙或撞到自己结束。" },
  { id: "2048", name: "2048", description: "滑动合并数字，挑战合成 2048。" },
  { id: "tetris", name: "俄罗斯方块", description: "消除整行方块，坚持越久分数越高。" },
  { id: "breakout", name: "打砖块", description: "弹板接球击碎砖块。" },
  { id: "memory", name: "翻牌记忆", description: "翻开配对卡牌，步数越少越好。" },
  { id: "maze", name: "投影回廊", description: "第一人称错觉解谜回廊，收集星星与钥匙通关。" }
];

export function isKnownGame(gameId: string): boolean {
  return GAMES.some((g) => g.id === gameId) || gameId.startsWith("ug_");
}
