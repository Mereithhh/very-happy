import { useTranslation } from '@/i18n/useTranslation';

export function SidebarOrderHint({ grouped, onUngroup }: { grouped: boolean; onUngroup: () => void }) {
    const { lang } = useTranslation();
    const zh = lang.startsWith('zh');
    return (
        <div className="sb-order-hint">
            {grouped ? <>
                <span>{zh ? '分组视图暂不支持手动排序' : 'Manual ordering is unavailable in grouped views'}</span>
                <button type="button" onClick={onUngroup}>{zh ? '切换到「最近」' : 'Switch to Recent'}</button>
            </> : <>
                <span className="sb-order-hint-fine">{zh ? '拖动会话调整顺序，也可用 ··· 菜单移动' : 'Drag to reorder, or move with the ··· menu'}</span>
                <span className="sb-order-hint-coarse">{zh ? '点击会话 ···，用上移 / 下移调整顺序' : 'Tap ··· on a conversation to move it up or down'}</span>
            </>}
            {/* B-947 */}
            <span className="sb-order-hint-note">{zh ? '顺序在打开页面时按最近活动排好，之后不随后台活动变化；刷新或在此菜单选「按最近活动重新排序」才重排' : 'The order is set by recent activity when the page loads and does not follow background activity; reload or pick "Re-sort by recent activity" in this menu to re-sort'}</span>
        </div>
    );
}
