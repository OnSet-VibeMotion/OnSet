/**
 * 内置插件在 apply(ctx) 里登记的操作（engine 的 plugin 包）照旧进操作表：工具服务、tool_help、客户端后端
 * （runStudioOp）与开发用的命令行都从操作表来，所以新增内置功能不用改 toolsmcp.ts。
 * 项目关掉某个内置插件时，它的操作由 flow.disabledAmOps 从工具列表里拿掉（与清单 am_ops 认领的同一条路）。
 */
import * as plugin from '@am/engine/plugin';
import { defineOp, removeOp, type Op } from './ops/op';

plugin.onPluginOps(
  (op) => {
    defineOp(op as Op);
  },
  (op) => removeOp(op.name),
);
