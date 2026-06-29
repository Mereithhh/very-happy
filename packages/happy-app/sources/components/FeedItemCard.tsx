import * as React from 'react';
import { FeedItem } from '@/sync/feedTypes';
import { Ionicons } from '@expo/vector-icons';
import { t } from '@/text';
import { Item } from './Item';
import { useUnistyles } from 'react-native-unistyles';

interface FeedItemCardProps {
    item: FeedItem;
}

export const FeedItemCard = React.memo(({ item }: FeedItemCardProps) => {
    const { theme } = useUnistyles();

    const getTimeAgo = (timestamp: number) => {
        const now = Date.now();
        const diff = now - timestamp;
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);
        
        if (minutes < 1) return t('time.justNow');
        if (minutes < 60) return t('time.minutesAgo', { count: minutes });
        if (hours < 24) return t('time.hoursAgo', { count: hours });
        return t('sessionHistory.daysAgo', { count: days });
    };
    
    switch (item.body.kind) {
        case 'friend_request':
        case 'friend_accepted':
            // Friends feature removed in self-hosted context.
            return null;

        case 'text':
            return (
                <Item
                    title={item.body.text}
                    subtitle={getTimeAgo(item.createdAt)}
                    icon={<Ionicons name="information-circle" size={20} color={theme.colors.textSecondary} />}
                    showChevron={false}
                />
            );
            
        default:
            return null;
    }
});