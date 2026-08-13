export interface ProductChangelogEntry {
  version: string;
  title: string;
  changes: string[];
}

export const PRODUCT_CHANGELOG: ProductChangelogEntry[] = [
  {
    version: "1.2.0-beta.3",
    title: "统一课后任务",
    changes: [
      "一次投入助教表、STEP 课堂文本和学生 PDF；拖拽、文件夹和固定收件箱共用同一套读取规则，并支持 ZIP。",
      "无冲突的确定性课堂事实自动应用，只把身份、日期、考勤冲突和其他异常留给教师处理。",
      "确认的共同课材料会按关联课次自动带入 FeedbackPlan；标准反馈、快速草稿和高级工作台仍可按原流程使用。",
    ],
  },
  {
    version: "1.2.0-beta.2",
    title: "多班反馈工作流",
    changes: [
      "同一学期的多个班级可以原子创建独立反馈计划，并按班级串行生成。",
      "批次支持暂停、继续、失败重试和刷新后的状态恢复。",
      "已批准的学生反馈可以跨班合并导出，仍保持逐班编辑和批准。",
      "改善弹窗、长文本编辑和标签页草稿保存时的输入稳定性。",
    ],
  },
  {
    version: "1.2.0-beta.1",
    title: "共同课与 STEP 基础",
    changes: [
      "同一学期的平行班可以组成班级组，共用共同课材料。",
      "教师确认后的共同课材料形成不可变修订，并可分别关联各班真实课次。",
      "STEP 实验桥保持单班、单课次和教师确认边界。",
    ],
  },
];
