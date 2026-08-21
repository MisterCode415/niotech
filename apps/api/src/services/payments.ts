import { randomUUID } from 'node:crypto';

export interface ChargeInput {
  orderId: string;
  orderNumber: string;
  amountCents: number;
  paymentToken: string;
}

export interface ChargeResult {
  status: 'paid' | 'failed';
  reference: string;
}

export interface PaymentProvider {
  readonly name: string;
  charge(input: ChargeInput): Promise<ChargeResult>;
}

/** Stands in until a real processor is chosen; captures instantly and records a traceable ref. */
class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';

  async charge(input: ChargeInput): Promise<ChargeResult> {
    return { status: 'paid', reference: `mock_${input.orderNumber}_${randomUUID().slice(0, 8)}` };
  }
}

export const paymentProvider: PaymentProvider = new MockPaymentProvider();
