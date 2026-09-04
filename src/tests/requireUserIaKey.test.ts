import { afterEach, describe, expect, it } from 'vitest';
import { requireUserIaKey } from '../libs/iaConfig/resolveIaCreds.js';

const originalValue = process.env.REQUIRE_USER_IA_KEY;

afterEach(() => {
  if (typeof originalValue === 'undefined') {
    delete process.env.REQUIRE_USER_IA_KEY;
  } else {
    process.env.REQUIRE_USER_IA_KEY = originalValue;
  }
});

describe('[Unidade] requireUserIaKey', () => {
  it('exige configuração da empresa por padrão', () => {
    delete process.env.REQUIRE_USER_IA_KEY;
    expect(requireUserIaKey()).toBe(true);
  });

  it('só libera o fallback quando explicitamente false', () => {
    process.env.REQUIRE_USER_IA_KEY = 'false';
    expect(requireUserIaKey()).toBe(false);
  });
});
