/**
 * 导演的 API key 在磁盘上的加密：Electron 的 safeStorage（macOS 上密钥在钥匙串里）。引擎不能 import electron，
 * 由这里注入（director.useKeyCodec）。进程内的后端写 key（/api/agent-keys）时加密，起导演前解密后经 stdin 交给它，
 * 见 director.loadKeys。safeStorage 用不了（isEncryptionAvailable 为 false）时引擎退回 0600 的明文文件，设置页照实说。
 *
 * isEncryptionAvailable 要在 app ready 之后才准，所以每次用时现问，不在注入时定死。
 * 端到端测试设 AM_AGENT_KEYS_PLAINTEXT=1 不注入：测试不能碰开发者的钥匙串（第一次用会弹授权框）。
 */
import { safeStorage } from 'electron';
import * as director from '@am/engine/director';

export function installKeyCodec(): void {
  if (process.env.AM_AGENT_KEYS_PLAINTEXT === '1') return;
  director.useKeyCodec({
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (cipher) => safeStorage.decryptString(Buffer.from(cipher, 'base64')),
  });
}
