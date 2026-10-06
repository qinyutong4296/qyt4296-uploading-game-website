import type { ComponentType } from "react";
import type { GameProps } from "./types";
import SnakeGame from "./snake/SnakeGame";
import Game2048 from "./2048/Game2048";
import TetrisGame from "./tetris/TetrisGame";
import BreakoutGame from "./breakout/BreakoutGame";
import MemoryGame from "./memory/MemoryGame";
import MazeGame from "./maze/MazeGame";

export type { GameProps };

export type GameMeta = {
  id: string;
  name: string;
  description: string;
  cover: string;
  component: ComponentType<GameProps>;
};

export const GAMES: GameMeta[] = [
  {
    id: "snake",
    name: "贪吃蛇",
    description: "方向键或 WASD 控制，吃到食物变长。",
    cover: "#3d5c48",
    component: SnakeGame
  },
  {
    id: "2048",
    name: "2048",
    description: "方向键合并数字，进度会自动存档。",
    cover: "#8a7a58",
    component: Game2048
  },
  {
    id: "tetris",
    name: "俄罗斯方块",
    description: "消除整行，进度会自动存档。",
    cover: "#4a555c",
    component: TetrisGame
  },
  {
    id: "breakout",
    name: "打砖块",
    description: "鼠标或方向键移动挡板击碎砖块。",
    cover: "#8b3a2f",
    component: BreakoutGame
  },
  {
    id: "memory",
    name: "翻牌记忆",
    description: "翻开配对卡牌，步数越少分数越高。",
    cover: "#5c574e",
    component: MemoryGame
  },
  {
    id: "maze",
    name: "投影回廊",
    description: "第一人称错觉解谜回廊，收集星星与钥匙通关。",
    cover: "#3a3f52",
    component: MazeGame
  }
];

export function getGame(id: string) {
  return GAMES.find((g) => g.id === id);
}
