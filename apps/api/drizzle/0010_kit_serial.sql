ALTER TABLE "kits" ADD COLUMN "serial" text;
--> statement-breakpoint
DO $$
DECLARE
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  kit record;
  candidate text;
BEGIN
  FOR kit IN SELECT id FROM kits WHERE serial IS NULL LOOP
    LOOP
      candidate := 'QK-';
      FOR i IN 1..8 LOOP
        candidate := candidate || substr(alphabet, 1 + floor(random() * 32)::int, 1);
        IF i = 4 THEN
          candidate := candidate || '-';
        END IF;
      END LOOP;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM kits WHERE serial = candidate);
    END LOOP;
    UPDATE kits SET serial = candidate WHERE id = kit.id;
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "kits" ALTER COLUMN "serial" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "kits_serial_key" ON "kits" ("serial");
