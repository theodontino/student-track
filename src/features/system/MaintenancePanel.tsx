"use client";

import ArchiveButton from "@/components/ArchiveButton";
import { Badge, Button, EmptyState, ErrorState, Input, LoadingState, PageHeader, Section, Select } from "@/components/ui";
import { ACTION_LABELS, formatLogDetail, TARGET_LABELS } from "./maintenance-types";
import { useMaintenanceLogs } from "./useMaintenanceLogs";

export default function MaintenancePanel() {
  const workspace = useMaintenanceLogs();
  return (
    <main className="system-maintenance-workspace">
      <PageHeader title="维护与操作日志" description={`记录评分变更、预警触发和数据删除等关键操作，共 ${workspace.total} 条；保留 90 天。`} />
      <Section title="数据库备份" description="创建一致性备份并记录校验信息，不改变业务数据。"><div className="system-backup-action"><ArchiveButton /></div></Section>
      <div className="system-log-filters"><Select aria-label="操作类型" value={workspace.filterAction} onChange={(event) => workspace.setFilterAction(event.target.value)}><option value="">全部操作类型</option>{Object.entries(ACTION_LABELS).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</Select><Input aria-label="搜索对象名称" type="search" placeholder="搜索学生名…" value={workspace.filterTargetName} onChange={(event) => workspace.setFilterTargetName(event.target.value)} /></div>
      {workspace.error && workspace.logs.length === 0 ? <ErrorState message={workspace.error} action={<Button onClick={() => void workspace.loadInitial()}>重试</Button>} /> : workspace.loading && workspace.logs.length === 0 ? <LoadingState label="正在读取操作日志…" /> : workspace.logs.length === 0 ? <EmptyState title="暂无操作日志" description="评分、删除等操作发生后会自动记录。" /> : <>
        {workspace.error && <div className="ui-banner ui-banner--danger" role="alert">{workspace.error}</div>}
        <div className="system-log-table-wrap"><table className="system-log-table"><thead><tr><th>时间</th><th>操作</th><th>对象</th><th>详情</th></tr></thead><tbody>{workspace.logs.map((log) => <tr key={log.id}><td><time>{new Date(log.createdAt).toLocaleString("zh-CN")}</time></td><td><Badge tone="info">{ACTION_LABELS[log.action] || log.action}</Badge></td><td><span>{TARGET_LABELS[log.targetType] || log.targetType}</span>{log.targetName && <strong>{log.targetName}</strong>}</td><td title={formatLogDetail(log.detail)}>{formatLogDetail(log.detail)}</td></tr>)}</tbody></table></div>
        {workspace.total > workspace.logs.length && <Button variant="secondary" onClick={() => void workspace.loadMore()} disabled={workspace.loading}>{workspace.loading ? "加载中…" : `加载更多（${workspace.logs.length}/${workspace.total}）`}</Button>}
      </>}
    </main>
  );
}
