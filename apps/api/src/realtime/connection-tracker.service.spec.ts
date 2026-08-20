import { ConnectionTracker } from './connection-tracker.service';

describe('ConnectionTracker', () => {
  it('starts at zero', () => {
    expect(new ConnectionTracker().activeConnections).toBe(0);
  });

  it('increments and decrements', () => {
    const tracker = new ConnectionTracker();

    tracker.increment();
    tracker.increment();
    expect(tracker.activeConnections).toBe(2);

    tracker.decrement();
    expect(tracker.activeConnections).toBe(1);
  });

  it('never goes negative', () => {
    const tracker = new ConnectionTracker();

    tracker.decrement();

    expect(tracker.activeConnections).toBe(0);
  });
});
