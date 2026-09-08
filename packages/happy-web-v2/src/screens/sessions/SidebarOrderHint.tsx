import { useTranslation } from '@/i18n/useTranslation';

export function SidebarOrderHint({ grouped, onUngroup }: { grouped: boolean; onUngroup: () => void }) {
    const { lang } = useTranslation();
    const zh = lang.startsWith('zh');
    return (
        <div className="sb-order-hint">
            {grouped ? <>
                <span>{zh ? '分组视图暂不支持手动排序' : 'Manual ordering is unavailable in grouped views'}</span>
                <button type="button" onClick={onUngroup}>{zh ? '切换为不分组' : 'Ungroup'}</button>
            </> : <>
                <span className="sb-order-hint-fine">{zh ? '拖动会话调整顺序，也可用 ··· 菜单移动' : 'Drag to reorder, or move with the ··· menu'}</span>
                <span className="sb-order-hint-coarse">{zh ? '点击会话 ···，用上移 / 下移调整顺序' : 'Tap ··· on a conversation to move it up or down'}</span>
            </>}
        </div>
    );
}
