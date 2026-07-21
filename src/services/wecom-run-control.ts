export type WeComCancelMode = "stop" | "stop_and_rollback";

export class WeComRunCancelledError extends Error {
  constructor(
    public readonly runId: string,
    public readonly mode: WeComCancelMode,
  ) {
    super(mode === "stop_and_rollback" ? "企微导入已请求停止并回滚" : "企微导入已请求停止");
    this.name = "WeComRunCancelledError";
  }
}
