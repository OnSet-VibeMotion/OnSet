/** 固定文案可用于盲评：不把供应商、模型、路径或日志正文透传给页面。 */
export function rendererFailureAdvice(message: string): { code: string; label: string; hint: string } | null {
  if (/OAuth token revoked|authentication_failed|authentication_error|failed to authenticate|unauthorized|未登录|登录.*失效/i.test(message)) {
    return { code: 'authentication', label: '工具登录已失效', hint: '先恢复该工具的登录，再重试这位选手。' };
  }
  if (/balance is low|insufficient[_ ]?(quota|balance|credit)|quota.*(exceed|exhaust)|额度不足|余额不足/i.test(message)) {
    return { code: 'quota', label: '模型额度不足', hint: '先补足该工具的可用额度，再重试。已有视频会优先验收。' };
  }
  if (/Empty stream|empty_model_response|finish_reason=error|overloaded|service unavailable|upstream.*(error|failed)|ECONNRESET|ETIMEDOUT/i.test(message)) {
    return { code: 'service', label: '模型服务异常结束', hint: '本次模型响应未完成，可以重试；不代表画面质量未通过。' };
  }
  return null;
}
