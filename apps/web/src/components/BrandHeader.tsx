import { BrandMark, useBrand, useHost } from '../lib/host';

/**
 * The tenant's logo or name above a public page. Renders nothing when the business unit has not
 * branded itself and the page is on the shared host, so unbranded tenants look as they always did.
 */
export function BrandHeader() {
  const host = useHost();
  const { brand } = useBrand();
  if (!host.custom && !brand?.logoUrl && !brand?.displayName) return null;
  return (
    <div className="brand-header">
      <span className="brand">
        <BrandMark />
      </span>
    </div>
  );
}
