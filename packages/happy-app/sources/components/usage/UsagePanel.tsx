import React, { useState, useEffect } from 'react';
import { View, ActivityIndicator, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { ItemGroup } from '@/components/ItemGroup';
import { UsageChart } from './UsageChart';
import { UsageBar } from './UsageBar';
import { getUsageForPeriod, calculateTotals, UsageDataPoint } from '@/sync/apiUsage';
import { Ionicons } from '@expo/vector-icons';
import { HappyError } from '@/utils/errors';
import { t } from '@/text';

type TimePeriod = 'today' | '7days' | '30days';
type ChartMetric = 'tokens' | 'cost';

interface SegmentOption<T extends string> {
    value: T;
    label: string;
}

// True segmented control: a single track with one highlighted segment.
function SegmentedControl<T extends string>({
    options,
    value,
    onChange,
}: {
    options: SegmentOption<T>[];
    value: T;
    onChange: (value: T) => void;
}) {
    return (
        <View style={styles.segmentTrack}>
            {options.map((opt) => {
                const active = opt.value === value;
                return (
                    <Pressable
                        key={opt.value}
                        style={[styles.segment, active && styles.segmentActive]}
                        onPress={() => onChange(opt.value)}
                    >
                        <Text style={[styles.segmentText, active && styles.segmentTextActive]} numberOfLines={1}>
                            {opt.label}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );
}

export const UsagePanel: React.FC<{ sessionId?: string }> = ({ sessionId }) => {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const [period, setPeriod] = useState<TimePeriod>('7days');
    const [chartMetric, setChartMetric] = useState<ChartMetric>('tokens');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [usageData, setUsageData] = useState<UsageDataPoint[]>([]);
    const [totals, setTotals] = useState({
        totalTokens: 0,
        totalCost: 0,
        tokensByModel: {} as Record<string, number>,
        costByModel: {} as Record<string, number>
    });

    useEffect(() => {
        loadUsageData();
    }, [period, sessionId]);

    const loadUsageData = async () => {
        if (!auth.credentials) {
            setError('Not authenticated');
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const response = await getUsageForPeriod(auth.credentials, period, sessionId);
            setUsageData(response.usage || []);
            setTotals(calculateTotals(response.usage || []));
        } catch (err) {
            console.error('Failed to load usage data:', err);
            if (err instanceof HappyError) {
                setError(err.message);
            } else {
                setError('Failed to load usage data');
            }
        } finally {
            setLoading(false);
        }
    };

    const formatTokens = (tokens: number): string => {
        if (tokens >= 1000000) {
            return `${(tokens / 1000000).toFixed(2)}M`;
        } else if (tokens >= 1000) {
            return `${(tokens / 1000).toFixed(1)}K`;
        }
        return tokens.toLocaleString();
    };

    const formatCost = (cost: number): string => {
        return `$${cost.toFixed(4)}`;
    };

    const periodOptions: SegmentOption<TimePeriod>[] = [
        { value: 'today', label: t('usage.today') },
        { value: '7days', label: t('usage.last7Days') },
        { value: '30days', label: t('usage.last30Days') },
    ];

    const metricOptions: SegmentOption<ChartMetric>[] = [
        { value: 'tokens', label: t('usage.tokens') },
        { value: 'cost', label: t('usage.cost') },
    ];

    if (loading) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color={theme.colors.button.primary.background} />
                <Text style={styles.loadingText}>{t('usage.usageOverTime')}</Text>
            </View>
        );
    }

    if (error) {
        return (
            <View style={styles.errorContainer}>
                <Ionicons name="alert-circle-outline" size={48} color={theme.colors.status.error} />
                <Text style={styles.errorText}>{error}</Text>
            </View>
        );
    }

    // Get top models by usage
    const topModels = Object.entries(totals.tokensByModel)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5);

    const maxModelTokens = Math.max(...Object.values(totals.tokensByModel), 1);

    return (
        <ScrollView style={styles.container}>
            {/* Period Selector (segmented) */}
            <View style={styles.controlRow}>
                <SegmentedControl
                    options={periodOptions}
                    value={period}
                    onChange={setPeriod}
                />
            </View>

            {/* Summary Stats */}
            <View style={styles.statsContainer}>
                <View style={styles.statRow}>
                    <Text style={styles.statLabel}>{t('usage.totalTokens')}</Text>
                    <Text style={styles.statValue}>{formatTokens(totals.totalTokens)}</Text>
                </View>
                <View style={styles.statRow}>
                    <Text style={styles.statLabel}>{t('usage.totalCost')}</Text>
                    <Text style={styles.statValue}>{formatCost(totals.totalCost)}</Text>
                </View>
            </View>

            {/* Usage Chart */}
            {usageData.length > 0 && (
                <View style={styles.chartSection}>
                    <Text style={styles.sectionTitle}>{t('usage.usageOverTime')}</Text>

                    {/* Metric Selector (segmented) */}
                    <View style={styles.controlRow}>
                        <SegmentedControl
                            options={metricOptions}
                            value={chartMetric}
                            onChange={setChartMetric}
                        />
                    </View>

                    <UsageChart
                        data={usageData}
                        metric={chartMetric}
                        height={180}
                    />
                </View>
            )}

            {/* Usage by Model */}
            {topModels.length > 0 && (
                <ItemGroup title={t('usage.byModel')}>
                    <View style={{ padding: 16 }}>
                        {topModels.map(([model, tokens]) => (
                            <UsageBar
                                key={model}
                                label={model}
                                value={tokens}
                                maxValue={maxModelTokens}
                                color={theme.colors.button.primary.background}
                            />
                        ))}
                    </View>
                </ItemGroup>
            )}
        </ScrollView>
    );
};

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
    },
    controlRow: {
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    segmentTrack: {
        flexDirection: 'row',
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 10,
        padding: 3,
        gap: 3,
    },
    segment: {
        flex: 1,
        paddingVertical: 7,
        paddingHorizontal: 12,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    segmentActive: {
        backgroundColor: theme.colors.button.primary.background,
    },
    segmentText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        fontWeight: '500',
    },
    segmentTextActive: {
        color: theme.colors.button.primary.tint,
        fontWeight: '600',
    },
    statsContainer: {
        padding: 16,
        backgroundColor: theme.colors.surface,
        margin: 16,
        borderRadius: 12,
        gap: 12,
    },
    statRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    statLabel: {
        fontSize: 16,
        color: theme.colors.text,
    },
    statValue: {
        fontSize: 20,
        fontWeight: '700',
        color: theme.colors.text,
    },
    chartSection: {
        marginTop: 16,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: theme.colors.text,
        marginHorizontal: 16,
        marginBottom: 8,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 32,
        gap: 12,
    },
    loadingText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
    },
    errorContainer: {
        padding: 32,
        alignItems: 'center',
    },
    errorText: {
        fontSize: 14,
        color: theme.colors.status.error,
        textAlign: 'center',
    },
}));
