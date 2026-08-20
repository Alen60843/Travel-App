import { RejectingSocketAuthenticator } from './socket-authenticator';

describe('RejectingSocketAuthenticator', () => {
  it('rejects a well-formed-looking token, proving the extension point fails closed', async () => {
    const authenticator = new RejectingSocketAuthenticator();

    await expect(authenticator.authenticate('looks-like-a-valid-jwt')).resolves.toBeNull();
  });

  it('rejects an absent token the same way', async () => {
    const authenticator = new RejectingSocketAuthenticator();

    await expect(authenticator.authenticate(undefined)).resolves.toBeNull();
  });

  it('only warns once per instance, not once per connection attempt', async () => {
    const authenticator = new RejectingSocketAuthenticator();
    // @ts-expect-error -- reaching into the private logger to assert on call count
    const warnSpy = jest.spyOn(authenticator.logger, 'warn');

    await authenticator.authenticate('a');
    await authenticator.authenticate('b');
    await authenticator.authenticate('c');

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
