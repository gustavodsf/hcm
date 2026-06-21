import { RequestStatus } from '../../src/common/enums';
import {
  RequestAction,
  TRANSITIONS,
  canTransition,
  isTerminal,
  nextState,
} from '../../src/common/state-machine';

describe('request state machine (TRD §3.3)', () => {
  it('DRAFT can submit or cancel', () => {
    expect(nextState(RequestStatus.DRAFT, RequestAction.SUBMIT)).toBe(RequestStatus.PENDING_APPROVAL);
    expect(nextState(RequestStatus.DRAFT, RequestAction.CANCEL)).toBe(RequestStatus.CANCELLED);
  });

  it('PENDING_APPROVAL can approve/reject/cancel', () => {
    expect(nextState(RequestStatus.PENDING_APPROVAL, RequestAction.APPROVE)).toBe(RequestStatus.APPROVED);
    expect(nextState(RequestStatus.PENDING_APPROVAL, RequestAction.REJECT)).toBe(RequestStatus.REJECTED);
    expect(nextState(RequestStatus.PENDING_APPROVAL, RequestAction.CANCEL)).toBe(RequestStatus.CANCELLED);
  });

  it('APPROVED commits or fails via HCM outcome, or cancels', () => {
    expect(nextState(RequestStatus.APPROVED, RequestAction.HCM_COMMITTED)).toBe(RequestStatus.COMMITTED);
    expect(nextState(RequestStatus.APPROVED, RequestAction.HCM_REJECTED)).toBe(RequestStatus.FAILED);
    expect(nextState(RequestStatus.APPROVED, RequestAction.CANCEL)).toBe(RequestStatus.CANCELLED);
  });

  it('COMMITTED cancel goes through a compensating CANCELLATION_PENDING', () => {
    expect(nextState(RequestStatus.COMMITTED, RequestAction.CANCEL)).toBe(RequestStatus.CANCELLATION_PENDING);
    expect(nextState(RequestStatus.CANCELLATION_PENDING, RequestAction.HCM_CREDIT_DONE)).toBe(
      RequestStatus.CANCELLED,
    );
  });

  it.each([RequestStatus.REJECTED, RequestStatus.CANCELLED, RequestStatus.FAILED])(
    '%s is terminal and rejects every action',
    (state) => {
      expect(isTerminal(state)).toBe(true);
      for (const action of Object.values(RequestAction)) {
        expect(canTransition(state, action)).toBe(false);
      }
    },
  );

  it('illegal transitions return null (e.g. approve a CANCELLED request)', () => {
    expect(nextState(RequestStatus.CANCELLED, RequestAction.APPROVE)).toBeNull();
    expect(canTransition(RequestStatus.COMMITTED, RequestAction.APPROVE)).toBe(false);
    expect(canTransition(RequestStatus.DRAFT, RequestAction.APPROVE)).toBe(false);
  });

  it('every state has an entry in the transition table (exhaustive)', () => {
    for (const state of Object.values(RequestStatus)) {
      expect(TRANSITIONS[state]).toBeDefined();
    }
  });
});
