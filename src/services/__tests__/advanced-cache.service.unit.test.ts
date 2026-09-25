import { DistributedCacheLock, CacheKeyBuilder } from '../advanced-cache.service';
import { v4 as uuidv4 } from 'uuid';

// Mock Redis client
const mockRedis = {
  set: jest.fn(),
  get: jest.fn(),
  del: jest.fn(),
  eval: jest.fn(),
  keys: jest.fn(),
  dbsize: jest.fn(),
  info: jest.fn(),
};

// Mock the redis config
jest.mock('../../config/redis', () => ({
  redis: mockRedis,
}));

jest.mock('../../config/redis.config', () => ({
  redisConfig: {
    defaultNamespace: 'mm',
    defaultTtl: 3600,
    defaultLockTtl: 30000,
    writeBehindQueueLimit: 1000,
  },
}));

jest.mock('../../utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('DistributedCacheLock', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset fake timers before each test
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('acquire', () => {
    it('should successfully acquire a lock on first attempt', async () => {
      // Mock successful SET NX response
      mockRedis.set.mockResolvedValueOnce('OK');

      const lockKey = 'test:resource';
      const lock = await DistributedCacheLock.acquire(lockKey, 30000);

      expect(lock).not.toBeNull();
      expect(lock).toMatchObject({
        key: expect.stringContaining('locks:test:resource'),
        value: expect.any(String),
        ttl: 30000,
        acquiredAt: expect.any(Number),
      });

      // Verify SET NX was called with correct parameters
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringContaining('locks:test:resource'),
        expect.any(String),
        'PX',
        30000,
        'NX'
      );
    });

    it('should return null when lock is already held (contention)', async () => {
      // Mock failed SET NX response (lock already exists)
      mockRedis.set.mockResolvedValueOnce(null);

      const lockKey = 'test:resource:contended';
      const lock = await DistributedCacheLock.acquire(lockKey, 30000);

      expect(lock).toBeNull();
      expect(mockRedis.set).toHaveBeenCalled();
    });

    it('should use default TTL when not specified', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');

      await DistributedCacheLock.acquire('test:default-ttl');

      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'PX',
        30000, // default lock TTL from config
        'NX'
      );
    });

    it('should handle Redis errors gracefully', async () => {
      mockRedis.set.mockRejectedValueOnce(new Error('Redis connection failed'));

      const lock = await DistributedCacheLock.acquire('test:error', 30000);

      expect(lock).toBeNull();
      expect(mockRedis.set).toHaveBeenCalled();
    });

    it('should generate unique lock values using UUIDs', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');

      const lock1 = await DistributedCacheLock.acquire('test:unique-1', 30000);
      const lock2 = await DistributedCacheLock.acquire('test:unique-2', 30000);

      expect(lock1?.value).not.toEqual(lock2?.value);
    });

    it('should include correct namespace in lock key', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');

      await DistributedCacheLock.acquire('myresource', 30000);

      const callArgs = mockRedis.set.mock.calls[0];
      const lockKey = callArgs[0];

      // Key should be formatted as: mm:locks:myresource
      expect(lockKey).toMatch(/^mm:locks:myresource/);
    });

    it('should store lock acquisition timestamp', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');
      const beforeAcquire = Date.now();

      const lock = await DistributedCacheLock.acquire('test:timestamp', 30000);

      const afterAcquire = Date.now();

      expect(lock?.acquiredAt).toBeGreaterThanOrEqual(beforeAcquire);
      expect(lock?.acquiredAt).toBeLessThanOrEqual(afterAcquire);
    });
  });

  describe('release', () => {
    it('should successfully release a lock using Lua script', async () => {
      // Mock successful Lua script execution (returns 1 for successful delete)
      mockRedis.eval.mockResolvedValueOnce(1);

      const lock = {
        key: 'mm:locks:test:resource',
        value: uuidv4(),
        ttl: 30000,
        acquiredAt: Date.now(),
      };

      const released = await DistributedCacheLock.release(lock);

      expect(released).toBe(true);
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call("GET", KEYS[1])'),
        1,
        lock.key,
        lock.value
      );
    });

    it('should return false when lock value does not match', async () => {
      // Mock Lua script execution returning 0 (lock value mismatch)
      mockRedis.eval.mockResolvedValueOnce(0);

      const lock = {
        key: 'mm:locks:test:resource',
        value: uuidv4(),
        ttl: 30000,
        acquiredAt: Date.now(),
      };

      const released = await DistributedCacheLock.release(lock);

      expect(released).toBe(false);
    });

    it('should only delete the lock if the stored value matches', async () => {
      mockRedis.eval.mockResolvedValueOnce(1);

      const lockValue = uuidv4();
      const lock = {
        key: 'mm:locks:test:resource',
        value: lockValue,
        ttl: 30000,
        acquiredAt: Date.now(),
      };

      await DistributedCacheLock.release(lock);

      // Verify Lua script received the exact lock value
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Number),
        lock.key,
        lockValue
      );
    });

    it('should handle Redis errors gracefully during release', async () => {
      mockRedis.eval.mockRejectedValueOnce(new Error('Redis error'));

      const lock = {
        key: 'mm:locks:test:resource',
        value: uuidv4(),
        ttl: 30000,
        acquiredAt: Date.now(),
      };

      const released = await DistributedCacheLock.release(lock);

      expect(released).toBe(false);
    });

    it('should execute Lua script with correct parameters', async () => {
      mockRedis.eval.mockResolvedValueOnce(1);

      const lock = {
        key: 'mm:locks:resource123',
        value: 'unique-lock-value-uuid',
        ttl: 30000,
        acquiredAt: Date.now(),
      };

      await DistributedCacheLock.release(lock);

      const [script, keysCount, ...args] = mockRedis.eval.mock.calls[0];

      expect(keysCount).toBe(1);
      expect(args).toContain(lock.key);
      expect(args).toContain('unique-lock-value-uuid');
      expect(script).toContain('GET');
      expect(script).toContain('DEL');
    });
  });

  describe('execute', () => {
    it('should execute a function while holding a lock', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');
      mockRedis.eval.mockResolvedValueOnce(1);

      const mockFn = jest.fn().mockResolvedValueOnce('success');

      const result = await DistributedCacheLock.execute(
        'test:critical',
        mockFn,
        30000
      );

      expect(result).toBe('success');
      expect(mockFn).toHaveBeenCalledOnce();
      expect(mockRedis.set).toHaveBeenCalled(); // acquire called
      expect(mockRedis.eval).toHaveBeenCalled(); // release called
    });

    it('should release lock even if function throws', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');
      mockRedis.eval.mockResolvedValueOnce(1);

      const mockFn = jest
        .fn()
        .mockRejectedValueOnce(new Error('Function failed'));

      await expect(
        DistributedCacheLock.execute('test:error', mockFn, 30000)
      ).rejects.toThrow('Function failed');

      expect(mockRedis.eval).toHaveBeenCalled(); // release was called
    });

    it('should retry acquisition on contention', async () => {
      // First two attempts fail (null), third succeeds
      mockRedis.set
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('OK');
      mockRedis.eval.mockResolvedValueOnce(1);

      const mockFn = jest.fn().mockResolvedValueOnce('success');

      const result = await DistributedCacheLock.execute(
        'test:retry',
        mockFn,
        30000,
        3, // retryCount
        10 // retryDelayMs
      );

      expect(result).toBe('success');
      expect(mockRedis.set).toHaveBeenCalledTimes(3);
    });

    it('should throw after exhausting retries', async () => {
      // All attempts fail
      mockRedis.set
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      const mockFn = jest.fn();

      await expect(
        DistributedCacheLock.execute(
          'test:exhausted',
          mockFn,
          30000,
          3, // retryCount
          10 // retryDelayMs
        )
      ).rejects.toThrow('Failed to acquire lock for key: test:exhausted');

      expect(mockFn).not.toHaveBeenCalled();
    });
  });

  describe('lock auto-expiry (TTL)', () => {
    it('should set correct TTL on lock acquisition', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');

      const ttl = 5000;
      await DistributedCacheLock.acquire('test:ttl', ttl);

      const callArgs = mockRedis.set.mock.calls[0];
      expect(callArgs[2]).toBe('PX'); // PX for milliseconds
      expect(callArgs[3]).toBe(ttl);
    });

    it('should respect TTL from config', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');

      // Call without specifying TTL to use default
      await DistributedCacheLock.acquire('test:default-ttl');

      const callArgs = mockRedis.set.mock.calls[0];
      expect(callArgs[3]).toBe(30000); // default from redisConfig
    });

    it('should simulate lock expiration with fake timers', async () => {
      jest.useFakeTimers();

      mockRedis.set.mockResolvedValueOnce('OK');

      const lock = await DistributedCacheLock.acquire('test:expiry', 5000);
      expect(lock).not.toBeNull();

      // Simulate time passing beyond TTL
      jest.advanceTimersByTime(5000);

      // In a real scenario, the lock would expire in Redis after 5000ms
      // This test verifies the TTL was set correctly
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'PX',
        5000,
        'NX'
      );

      jest.useRealTimers();
    });

    it('should handle multiple concurrent lock attempts with TTL', async () => {
      jest.useFakeTimers();

      mockRedis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);

      // First acquire succeeds
      const lock1 = await DistributedCacheLock.acquire('test:concurrent', 5000);
      expect(lock1).not.toBeNull();

      // Second acquire fails (lock held)
      const lock2 = await DistributedCacheLock.acquire('test:concurrent', 5000);
      expect(lock2).toBeNull();

      // After TTL expires in Redis, next acquire would succeed
      jest.advanceTimersByTime(5000);
      mockRedis.set.mockResolvedValueOnce('OK');
      const lock3 = await DistributedCacheLock.acquire('test:concurrent', 5000);
      expect(lock3).not.toBeNull();

      jest.useRealTimers();
    });
  });

  describe('Lua script behavior', () => {
    it('should use correct Lua script for conditional release', async () => {
      mockRedis.eval.mockResolvedValueOnce(1);

      const lock = {
        key: 'mm:locks:test',
        value: 'test-uuid',
        ttl: 30000,
        acquiredAt: Date.now(),
      };

      await DistributedCacheLock.release(lock);

      const luaScript = mockRedis.eval.mock.calls[0][0];

      // Verify script checks value before deleting
      expect(luaScript).toContain('redis.call("GET", KEYS[1])');
      expect(luaScript).toContain('ARGV[1]');
      expect(luaScript).toContain('redis.call("DEL", KEYS[1])');
    });

    it('should prevent release of locks owned by other clients', async () => {
      mockRedis.eval.mockResolvedValueOnce(0); // Mismatch returns 0

      const lock = {
        key: 'mm:locks:resource',
        value: 'original-uuid',
        ttl: 30000,
        acquiredAt: Date.now(),
      };

      // Attempt to release with different UUID
      const released = await DistributedCacheLock.release(lock);

      expect(released).toBe(false);
      // Verify eval was called with the provided UUID
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.any(String),
        1,
        'mm:locks:resource',
        'original-uuid'
      );
    });
  });

  describe('edge cases', () => {
    it('should handle very short TTL', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');

      const lock = await DistributedCacheLock.acquire('test:short-ttl', 100);

      expect(lock?.ttl).toBe(100);
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'PX',
        100,
        'NX'
      );
    });

    it('should handle very long TTL', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');

      const longTtl = 86400000; // 24 hours
      const lock = await DistributedCacheLock.acquire('test:long-ttl', longTtl);

      expect(lock?.ttl).toBe(longTtl);
    });

    it('should handle empty key name', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');

      const lock = await DistributedCacheLock.acquire('', 30000);

      expect(lock).not.toBeNull();
      expect(mockRedis.set).toHaveBeenCalled();
    });

    it('should handle special characters in lock key', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');

      const specialKey = 'test:resource:with-special_chars.123';
      const lock = await DistributedCacheLock.acquire(specialKey, 30000);

      expect(lock).not.toBeNull();
      expect(lock?.key).toContain('locks');
    });

    it('should produce correct lock metadata', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');

      const beforeTime = Date.now();
      const lock = await DistributedCacheLock.acquire('test:metadata', 15000);
      const afterTime = Date.now();

      expect(lock).toMatchObject({
        key: expect.stringContaining('locks'),
        value: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        ), // UUID format
        ttl: 15000,
        acquiredAt: expect.any(Number),
      });

      expect(lock!.acquiredAt).toBeGreaterThanOrEqual(beforeTime);
      expect(lock!.acquiredAt).toBeLessThanOrEqual(afterTime);
    });
  });

  describe('CacheKeyBuilder integration', () => {
    it('should create properly namespaced lock keys', () => {
      const builtKey = CacheKeyBuilder.create('locks', 'resource');

      expect(builtKey).toMatch(/^mm:locks:resource/);
    });

    it('should handle multiple path segments in key builder', () => {
      const builtKey = CacheKeyBuilder.create('locks', 'app', 'resource', 'id123');

      expect(builtKey).toMatch(/^mm:locks:app:resource:id123/);
    });
  });
});
