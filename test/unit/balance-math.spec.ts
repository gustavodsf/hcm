import {
  canReserve,
  computeAvailable,
  isOverAllocated,
  toView,
} from '../../src/common/balance-math';

describe('balance-math (TRD §6)', () => {
  it('available = hcmBalance − reservedOpen − committedPending', () => {
    expect(computeAvailable({ hcmBalance: 10, reservedOpen: 2, committedPending: 3 })).toBe(5);
  });

  it('keeps subtracting committedPending so spent balance is not re-offered (C7)', () => {
    // We debited HCM (committed 4) but HCM snapshot has not yet absorbed it.
    expect(computeAvailable({ hcmBalance: 10, reservedOpen: 0, committedPending: 4 })).toBe(6);
  });

  it('can be negative after a downward HCM correction (C9) — never clamps', () => {
    const c = { hcmBalance: 5, reservedOpen: 8, committedPending: 0 };
    expect(computeAvailable(c)).toBe(-3);
    expect(isOverAllocated(c)).toBe(true);
  });

  describe('canReserve', () => {
    it('allows reserving up to exactly available', () => {
      expect(canReserve({ hcmBalance: 10, reservedOpen: 0, committedPending: 0 }, 10)).toBe(true);
    });
    it('rejects reserving more than available', () => {
      expect(canReserve({ hcmBalance: 10, reservedOpen: 9, committedPending: 0 }, 2)).toBe(false);
    });
    it('rejects zero/negative day requests', () => {
      const c = { hcmBalance: 10, reservedOpen: 0, committedPending: 0 };
      expect(canReserve(c, 0)).toBe(false);
      expect(canReserve(c, -1)).toBe(false);
    });
  });

  it('toView attaches the derived available', () => {
    expect(toView({ hcmBalance: 7, reservedOpen: 1, committedPending: 1 })).toEqual({
      hcmBalance: 7,
      reservedOpen: 1,
      committedPending: 1,
      available: 5,
    });
  });
});
