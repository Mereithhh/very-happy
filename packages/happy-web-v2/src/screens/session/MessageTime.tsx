import { useTranslation } from '@/i18n/useTranslation';
import { compactMessageTime, messageTimestamp } from './messageTimestamp';

/** A compact, visible time with the original date and timezone available on hover. */
export function MessageTime({ createdAt }: { createdAt?: number | null }) {
    const { lang } = useTranslation();
    const label = compactMessageTime(createdAt, lang);
    if (!label) return null;
    return <time className="msg-time" dateTime={new Date(createdAt!).toISOString()} title={messageTimestamp(createdAt, lang)}>{label}</time>;
}
