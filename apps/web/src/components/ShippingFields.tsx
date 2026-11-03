import { SHIPPING_METHODS, SHIPPING_METHOD_LABELS } from '@nio/shared';
import { Field } from './ui';

export interface ShippingAddressForm {
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

export const EMPTY_SHIPPING_ADDRESS: ShippingAddressForm = {
  line1: '',
  line2: '',
  city: '',
  region: '',
  postalCode: '',
  country: 'US',
};

/** Shared by the signed-in and guest checkout forms so both collect exactly the same fields. */
export function ShippingFields({
  address,
  onAddress,
  shippingMethod,
  onShippingMethod,
}: {
  address: ShippingAddressForm;
  onAddress: (address: ShippingAddressForm) => void;
  shippingMethod: string;
  onShippingMethod: (method: string) => void;
}) {
  return (
    <>
      <Field label="Address line 1">
        <input
          value={address.line1}
          onChange={(e) => onAddress({ ...address, line1: e.target.value })}
          required
        />
      </Field>
      <Field label="Address line 2">
        <input
          value={address.line2}
          onChange={(e) => onAddress({ ...address, line2: e.target.value })}
        />
      </Field>

      <div className="field-row">
        <Field label="City">
          <input
            value={address.city}
            onChange={(e) => onAddress({ ...address, city: e.target.value })}
            required
          />
        </Field>
        <Field label="State / region">
          <input
            value={address.region}
            onChange={(e) => onAddress({ ...address, region: e.target.value })}
            required
          />
        </Field>
        <Field label="Postal code">
          <input
            value={address.postalCode}
            onChange={(e) => onAddress({ ...address, postalCode: e.target.value })}
            required
          />
        </Field>
      </div>

      <Field label="Shipping speed">
        <select value={shippingMethod} onChange={(e) => onShippingMethod(e.target.value)}>
          {SHIPPING_METHODS.map((method) => (
            <option key={method} value={method}>
              {SHIPPING_METHOD_LABELS[method]}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}
