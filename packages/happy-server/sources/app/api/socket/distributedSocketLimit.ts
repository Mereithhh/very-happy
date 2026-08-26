import type { Redis } from 'ioredis';

const ACQUIRE = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local expires = tonumber(ARGV[2])
local member = ARGV[3]
local limit = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
if redis.call('ZSCORE', key, member) then
  redis.call('ZADD', key, expires, member)
  redis.call('PEXPIRE', key, expires - now + 1000)
  return 1
end
if limit > 0 and redis.call('ZCARD', key) >= limit then return 0 end
redis.call('ZADD', key, expires, member)
redis.call('PEXPIRE', key, expires - now + 1000)
return 1
`;

export class DistributedSocketConnectionLimiter {
    constructor(
        private readonly redis: Redis,
        private readonly limit: number,
        private readonly ttlMs = 60_000,
    ) {}

    private key(accountId: string): string {
        return `vh:socket-connections:${accountId}`;
    }

    async acquire(accountId: string, member: string, now = Date.now()): Promise<boolean> {
        const result = await this.redis.eval(
            ACQUIRE,
            1,
            this.key(accountId),
            now,
            now + this.ttlMs,
            member,
            this.limit,
        );
        return Number(result) === 1;
    }

    async refresh(accountId: string, member: string, now = Date.now()): Promise<boolean> {
        return this.acquire(accountId, member, now);
    }

    async release(accountId: string, member: string): Promise<void> {
        await this.redis.zrem(this.key(accountId), member);
    }
}
