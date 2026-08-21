import { safeProvisionSourceIp, safeProvisionUserAgent } from './users.controller';

describe('provisioning transport metadata', () => {
  it('accepts only syntactically valid server-derived IP addresses', () => {
    expect(safeProvisionSourceIp({ ip: '127.0.0.1', headers: {} })).toBe('127.0.0.1');
    expect(safeProvisionSourceIp({ socket: { remoteAddress: '::1' }, headers: {} })).toBe('::1');
    expect(safeProvisionSourceIp({ ip: 'fe80::1%lo0', headers: {} })).toBe('fe80::1');
    expect(safeProvisionSourceIp({ ip: 'not-an-ip', headers: {} })).toBeNull();
  });

  it('strips PostgreSQL-invalid NULs and bounds user-agent metadata', () => {
    expect(safeProvisionUserAgent({ 'user-agent': 'agent\0name' })).toBe('agentname');
    expect(safeProvisionUserAgent({ 'user-agent': 'a'.repeat(2_000) })).toHaveLength(1_000);
    expect(safeProvisionUserAgent({})).toBeNull();
  });
});
