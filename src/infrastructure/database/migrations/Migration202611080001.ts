import { Migration } from '@mikro-orm/migrations';

export class Migration202611080001 extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY, player_id uuid NOT NULL, currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance numeric(20,2) NOT NULL CHECK (balance >= 0), version integer NOT NULL CHECK (version >= 1),
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
        UNIQUE (player_id, currency), UNIQUE(id, currency)
      );
      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY, provider_id text NOT NULL, external_transaction_id text NOT NULL,
        idempotency_key text NOT NULL UNIQUE, payload_hash char(64) NOT NULL,
        wallet_id uuid NOT NULL REFERENCES wallets(id), player_id uuid NOT NULL,
        round_id text NOT NULL, game_id text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount numeric(20,2) NOT NULL CHECK (amount >= 0 AND (kind = 'LOSS' OR amount > 0)),
        currency char(3) NOT NULL, reference_external_transaction_id text,
        reference_transaction_id uuid REFERENCES wager_transactions(id),
        direction text CHECK (direction IN ('DEBIT','CREDIT')),
        status text NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code text, result jsonb, created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
        attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz,
        UNIQUE(provider_id, external_transaction_id), UNIQUE(id, wallet_id, currency),
        CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CHECK (status <> 'PROCESSED' OR (processed_at IS NOT NULL AND (kind NOT IN ('REFUND','ROLLBACK') OR reference_transaction_id IS NOT NULL))),
        CHECK (status NOT IN ('REJECTED','FAILED') OR failure_code IS NOT NULL)
      );
      CREATE UNIQUE INDEX single_reversal ON wager_transactions(reference_transaction_id, kind)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');
      CREATE INDEX pending_references ON wager_transactions(next_attempt_at, id) WHERE status = 'PENDING_REFERENCE';
      CREATE TABLE wallet_ledger (
        id uuid PRIMARY KEY, sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
        wallet_id uuid NOT NULL, transaction_id uuid NOT NULL, direction text NOT NULL CHECK(direction IN ('DEBIT','CREDIT')),
        amount numeric(20,2) NOT NULL CHECK(amount > 0), currency char(3) NOT NULL,
        balance_before numeric(20,2) NOT NULL CHECK(balance_before >= 0),
        balance_after numeric(20,2) NOT NULL CHECK(balance_after >= 0), created_at timestamptz NOT NULL,
        FOREIGN KEY(wallet_id, currency) REFERENCES wallets(id, currency),
        FOREIGN KEY(transaction_id, wallet_id, currency) REFERENCES wager_transactions(id, wallet_id, currency),
        UNIQUE(wallet_id, transaction_id),
        CHECK(balance_after = balance_before + CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)
      );
      CREATE INDEX ledger_cursor ON wallet_ledger(wallet_id, sequence);
      CREATE TABLE inbox (
        consumer_name text NOT NULL, message_id text NOT NULL, payload_hash char(64) NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
        PRIMARY KEY(consumer_name, message_id)
      );
      CREATE TABLE outbox (
        id uuid PRIMARY KEY, aggregate_id uuid NOT NULL, event_type text NOT NULL, payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz
      );
      CREATE INDEX outbox_due ON outbox(next_attempt_at, id) WHERE published_at IS NULL;
      CREATE FUNCTION prevent_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'ledger is append-only'; END $$;
      CREATE TRIGGER immutable_ledger BEFORE UPDATE OR DELETE OR TRUNCATE ON wallet_ledger
        FOR EACH STATEMENT EXECUTE FUNCTION prevent_ledger_mutation();
      CREATE FUNCTION protect_terminal_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN RAISE EXCEPTION 'terminal transaction is immutable'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER terminal_transaction BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION protect_terminal_transaction();
      CREATE FUNCTION verify_wallet_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE target uuid; stored numeric; calculated numeric;
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN target := NEW.id; ELSE target := NEW.wallet_id; END IF;
        SELECT balance INTO stored FROM wallets WHERE id = target;
        SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END),0)
          INTO calculated FROM wallet_ledger WHERE wallet_id = target;
        IF stored IS DISTINCT FROM calculated THEN RAISE EXCEPTION 'wallet/ledger mismatch'; END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER wallet_matches_ledger AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_wallet_ledger();
      CREATE CONSTRAINT TRIGGER ledger_matches_wallet AFTER INSERT ON wallet_ledger
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_wallet_ledger();
      CREATE FUNCTION verify_transaction_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE target uuid; tx wager_transactions; entries integer;
      BEGIN
        IF TG_TABLE_NAME = 'wager_transactions' THEN target := NEW.id; ELSE target := NEW.transaction_id; END IF;
        SELECT * INTO tx FROM wager_transactions WHERE id = target;
        SELECT COUNT(*) INTO entries FROM wallet_ledger WHERE transaction_id = target;
        IF (tx.status = 'PROCESSED' AND tx.kind <> 'LOSS' AND entries <> 1)
          OR ((tx.status <> 'PROCESSED' OR tx.kind = 'LOSS') AND entries <> 0)
          OR EXISTS (SELECT 1 FROM wallet_ledger WHERE transaction_id = target
             AND (amount <> tx.amount OR direction <> tx.direction))
        THEN RAISE EXCEPTION 'transaction/ledger mismatch'; END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER transaction_has_ledger AFTER INSERT OR UPDATE ON wager_transactions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_transaction_ledger();
      CREATE CONSTRAINT TRIGGER ledger_has_transaction AFTER INSERT ON wallet_ledger
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_transaction_ledger();
    `);
  }
  override down(): void {
    this
      .addSql(`DROP TABLE outbox, inbox, wallet_ledger, wager_transactions, wallets CASCADE;
      DROP FUNCTION verify_transaction_ledger(), verify_wallet_ledger(), protect_terminal_transaction(), prevent_ledger_mutation();`);
  }
}
