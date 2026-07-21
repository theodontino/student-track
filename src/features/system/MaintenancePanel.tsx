"use client";

import ArchiveButton from "@/components/ArchiveButton";
import { Badge, Button, EmptyState, ErrorState, FormField, Input, LoadingState, PageHeader, Section, Select } from "@/components/ui";
import { ACTION_LABELS, formatLogDetail, TARGET_LABELS } from "./maintenance-types";
import { useMaintenanceLogs } from "./useMaintenanceLogs";
import LLMCachePanel from "./LLMCachePanel";

export default function MaintenancePanel() {
  const workspace = useMaintenanceLogs();
  return (
    <main className="system-maintenance-workspace">
      <PageHeader title="维护与操作日志" description="集中管理本机备份、模型缓存和关键操作记录。" />
      <Section title="数据库备份" description="创建一致性备份并记录校验信息，不改变业务数据。"><div className="system-backup-action"><ArchiveButton /></div></Section>
      <LLMCachePanel />
      <Section className="system-log-section" title="操作日志" description={`记录评分变更、预警触发和数据删除等关键操作，共 ${workspace.total} 条；保留 90 天。`}>
        <div className="system-log-section__body">
          <div className="system-log-filters">
            <FormField id="system-log-action" label="操作类型"><Select id="system-log-action" value={workspace.filterAction} onChange={(event) => workspace.setFilterAction(event.target.value)}><option value="">全部操作类型</option>{Object.entries(ACTION_LABELS).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</Select></FormField>
            <FormField id="system-log-target" label="对象名称"><Input id="system-log-target" type="search" placeholder="搜索学生名…" value={workspace.filterTargetName} onChange={(event) => workspace.setFilterTargetName(event.target.value)} /></FormField>
          </div>
          {workspace.error && workspace.logs.length === 0 ? <ErrorState message={workspace.error} action={<Button onClick={() => void workspace.loadInitial()}>重试</Button>} /> : workspace.loading && workspace.logs.length === 0 ? <LoadingState label="正在读取操作日志…" /> : workspace.logs.length === 0 ? <EmptyState title="暂无操作日志" description="评分、删除等操作发生后会自动记录。" /> : <>
            {workspace.error && <div className="ui-banner ui-banner--danger" role="alert">{workspace.error}</div>}
            <div className="system-log-table-wrap"><table className="system-log-table"><colgroup><col className="system-log-table__time" /><col className="system-log-table__action" /><col className="system-log-table__target" /><col /></colgroup><thead><tr><th>时间</th><th>操作</th><th>对象</th><th>详情</th></tr></thead><tbody>{workspace.logs.map((log) => <tr key={log.id}><td><time>{new Date(log.createdAt).toLocaleString("zh-CN")}</time></td><td><Badge tone="info">{ACTION_LABELS[log.action] || log.action}</Badge></td><td><span className="system-log-table__target-type">{TARGET_LABELS[log.targetType] || log.targetType}</span>{log.targetName && <strong>{log.targetName}</strong>}</td><td><code title={formatLogDetail(log.detail)}>{formatLogDetail(log.detail)}</code></td></tr>)}</tbody></table></div>
            {workspace.total > workspace.logs.length && <Button className="system-log-load-more" variant="secondary" onClick={() => void workspace.loadMore()} disabled={workspace.loading}>{workspace.loading ? "加载中…" : `加载更多（${workspace.logs.length}/${workspace.total}）`}</Button>}
          </>}
        </div>
      </Section>
    </main>
  );
}
