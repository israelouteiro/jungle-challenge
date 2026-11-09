import { Migration } from '@mikro-orm/migrations';

export class Migration202611080002 extends Migration {
  override up(): void {
    this.addSql(`
      CREATE FUNCTION protect_wallet_state() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id OR NEW.currency <> OLD.currency THEN
          RAISE EXCEPTION 'wallet identity is immutable';
        END IF;
        IF NEW.version <> OLD.version + (CASE WHEN NEW.balance <> OLD.balance THEN 1 ELSE 0 END) THEN
          RAISE EXCEPTION 'invalid wallet version';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER wallet_state BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION protect_wallet_state();
      ALTER TABLE wager_transactions ADD CONSTRAINT processed_direction CHECK (
        status <> 'PROCESSED' OR ((kind='LOSS' AND direction IS NULL) OR (kind<>'LOSS' AND direction IS NOT NULL))
      );
    `);
  }
  override down(): void {
    this
      .addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT processed_direction;
      DROP TRIGGER wallet_state ON wallets;
      DROP FUNCTION protect_wallet_state();`);
  }
}
