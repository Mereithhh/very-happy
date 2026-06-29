import React from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import { StyleSheet } from 'react-native-unistyles';
import { UsageDataPoint } from '@/sync/apiUsage';
import { t } from '@/text';

interface UsageChartProps {
    data: UsageDataPoint[];
    metric: 'tokens' | 'cost';
    height?: number;
    onBarPress?: (dataPoint: UsageDataPoint, index: number) => void;
}

export const UsageChart: React.FC<UsageChartProps> = React.memo(({
    data,
    metric,
    height = 200,
    onBarPress
}) => {
    if (!data || data.length === 0) {
        return (
            <View style={styles.emptyState}>
                <Text style={styles.emptyText}>{t('usage.noData')}</Text>
            </View>
        );
    }

    const getValueForDataPoint = (point: UsageDataPoint): number => {
        const source = metric === 'tokens' ? point.tokens : point.cost;
        return Object.values(source).reduce((sum, val) => sum + (val || 0), 0);
    };

    const maxValue = Math.max(...data.map(getValueForDataPoint), 1);

    // Format date label
    const formatLabel = (timestamp: number): string => {
        const date = new Date(timestamp * 1000);
        const now = new Date();
        const isToday = date.toDateString() === now.toDateString();

        if (isToday) {
            return date.toLocaleTimeString('en-US', { hour: 'numeric' });
        }
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    };

    // Format value for display
    const formatValue = (value: number): string => {
        if (metric === 'cost') {
            return `$${value.toFixed(2)}`;
        } else if (value >= 1000000) {
            return `${(value / 1000000).toFixed(1)}M`;
        } else if (value >= 1000) {
            return `${(value / 1000).toFixed(1)}K`;
        }
        return value.toFixed(0);
    };

    // Limit bars to show (for better visibility)
    const maxBarsToShow = 30;
    const displayData = data.length > maxBarsToShow
        ? data.slice(-maxBarsToShow)
        : data;

    // Sparse labels: only show first, last, and a few evenly spaced in between
    // to avoid crowded / overlapping x-axis ticks.
    const lastIndex = displayData.length - 1;
    const maxLabels = 6;
    const step = lastIndex > 0 ? Math.max(1, Math.ceil(displayData.length / maxLabels)) : 1;
    const shouldShowLabel = (index: number): boolean => {
        if (index === 0 || index === lastIndex) return true;
        return index % step === 0;
    };

    return (
        <View style={styles.container}>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                bounces={false}
            >
                <View style={[styles.chartContainer, { height }]}>
                    {displayData.map((point, index) => {
                        const value = getValueForDataPoint(point);
                        const fillHeight = Math.max((value / maxValue) * height, value > 0 ? 2 : 0);
                        const showValue = value > 0 && fillHeight > 24;

                        return (
                            <Pressable
                                key={`${point.timestamp}-${index}`}
                                style={[styles.barWrapper, { minWidth: 40 }]}
                                onPress={() => onBarPress?.(point, index)}
                            >
                                {showValue && (
                                    <Text style={styles.barValue} numberOfLines={1}>
                                        {formatValue(value)}
                                    </Text>
                                )}
                                {/* Constant full-height track (background, not encoding) */}
                                <View style={[styles.track, { height }]}>
                                    {/* Single solid teal fill encodes the metric value */}
                                    <View style={[styles.barFill, { height: fillHeight }]} />
                                </View>
                                <Text
                                    style={styles.barLabel}
                                    numberOfLines={1}
                                >
                                    {shouldShowLabel(index) ? formatLabel(point.timestamp) : ''}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>
            </ScrollView>
        </View>
    );
});

UsageChart.displayName = 'UsageChart';

const styles = StyleSheet.create((theme) => ({
    container: {
        marginVertical: 16,
    },
    chartContainer: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        paddingHorizontal: 8,
        paddingBottom: 24, // Space for sparse labels
    },
    barWrapper: {
        flex: 1,
        alignItems: 'center',
        marginHorizontal: 2,
    },
    track: {
        width: '100%',
        borderRadius: 4,
        backgroundColor: theme.colors.surfaceHigh,
        justifyContent: 'flex-end',
        overflow: 'hidden',
    },
    barFill: {
        width: '100%',
        borderRadius: 4,
        backgroundColor: theme.colors.button.primary.background,
    },
    barValue: {
        fontSize: 10,
        color: theme.colors.textSecondary,
        marginBottom: 4,
        fontWeight: '600',
    },
    barLabel: {
        position: 'absolute',
        bottom: -20,
        fontSize: 10,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        width: 56,
    },
    emptyState: {
        padding: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
    }
}));
