import { EntityManager } from '@mikro-orm/postgresql';
import { WalletRepository } from '../../../application/ports/financial-unit-of-work';
import { Wallet } from '../../../domain/wallet';
import { Money } from '../../../domain/money';
import { WalletRecord } from '../wallet-record';

export class SqlWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}
  async exists(id: string): Promise<boolean> {
    return (
      (await this.em.execute('SELECT id FROM wallets WHERE id=?', [id]))
        .length > 0
    );
  }
  async create(wallet: Wallet): Promise<void> {
    this.em.persist(
      this.em.create(WalletRecord, {
        id: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balance: wallet.balance.toString(),
        version: wallet.version,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      }),
    );
    await this.em.flush();
  }
  async lock(id: string): Promise<Wallet | undefined> {
    // FK insertion takes KEY SHARE on wallets. NO KEY UPDATE serializes balances
    // while remaining compatible with those references, avoiding lock-upgrade deadlocks.
    const locked = await this.em.execute(
      'SELECT id FROM wallets WHERE id=? FOR NO KEY UPDATE',
      [id],
    );
    if (!locked.length) return undefined;
    const row = await this.em.findOne(WalletRecord, { id }, { refresh: true });
    return row
      ? Wallet.rehydrate({
          ...row,
          balance: Money.rehydrate({
            amount: row.balance,
            currency: row.currency,
          }),
        })
      : undefined;
  }
  async save(wallet: Wallet): Promise<void> {
    const row = this.em.getReference(WalletRecord, wallet.id);
    row.balance = wallet.balance.toString();
    row.version = wallet.version;
    row.updatedAt = wallet.updatedAt;
    await this.em.flush();
  }
}
