import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_ACCESS_KEY: 'access-key',
  STORAGE_SECRET_KEY: 'secret-key',
};

const validate = (env: Record<string, string>) => {
  const result = envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );
  return {
    error: result.error,
    value: result.value as Record<string, unknown>,
  };
};

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage credentials', () => {
  it('should reject bootstrap without STORAGE_ACCESS_KEY', () => {
    const env: Partial<typeof requiredEnv> = { ...requiredEnv };
    delete env.STORAGE_ACCESS_KEY;
    const { error } = envValidationSchema.validate(env, {
      allowUnknown: true,
      abortEarly: false,
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ACCESS_KEY');
  });

  it('should reject bootstrap without STORAGE_SECRET_KEY', () => {
    const env: Partial<typeof requiredEnv> = { ...requiredEnv };
    delete env.STORAGE_SECRET_KEY;
    const { error } = envValidationSchema.validate(env, {
      allowUnknown: true,
      abortEarly: false,
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_SECRET_KEY');
  });
});

describe('envValidationSchema — queue and video defaults', () => {
  it('should apply QUEUE_* defaults pointing to the redis service', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.QUEUE_HOST).toBe('redis');
    expect(value.QUEUE_PORT).toBe(6379);
  });

  it('should apply VIDEO_* defaults', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.VIDEO_MAX_UPLOAD_BYTES).toBe(10737418240);
    expect(value.VIDEO_UPLOAD_PART_URL_TTL_SECONDS).toBe(3600);
    expect(value.VIDEO_PLAYBACK_URL_TTL_SECONDS).toBe(900);
    expect(value.VIDEO_DRAFT_TTL_HOURS).toBe(24);
    expect(value.VIDEO_MULTIPART_ABORT_DAYS).toBe(1);
  });

  it('should apply STORAGE_* defaults for non-credential keys', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.STORAGE_ENDPOINT).toBe('http://minio:9000');
    expect(value.STORAGE_REGION).toBe('us-east-1');
    expect(value.STORAGE_BUCKET).toBe('streamtube');
  });
});
