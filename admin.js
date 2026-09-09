const fs = require('fs');
const path = require('path');
const store = require('./store');
const { webhookUrl } = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const [cmd, ...args] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case 'codegen': {
      const amount = Number(args[0]);
      const count = Number(args[1] || 1);
      if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(count) || count > 500) {
        console.log('Usage: node admin.js codegen <amount> <count>');
        process.exit(1);
      }
      const codes = store.createWalletCodes(amount, count);
      console.log(`${codes.length} recharge code(s) worth $${amount} each:`);
      codes.forEach(c => console.log('  ' + c));
      break;
    }
    case 'codes': {
      console.log('Unused wallet codes:');
      store.unusedWalletCodes().forEach(c => console.log(`  ${c.code}  ->  $${c.amount}`));
      if (store.unusedWalletCodes().length === 0) console.log('  (none)');
      break;
    }
    case 'promo': {
      const [code, discount, maxUses] = args;
      if (!code || !Number.isFinite(Number(discount)) || !Number.isInteger(Number(maxUses))) {
        console.log('Usage: node admin.js promo <CODE> <discountPercent> <maxUses>');
        process.exit(1);
      }
      const promo = store.addPromoCode(code.toUpperCase(), Number(discount), Number(maxUses));
      console.log(`Promo ${promo.code}: ${promo.discount}% off, max ${promo.maxUses} uses, used ${promo.uses}x`);
      break;
    }
    case 'promos': {
      console.log('Promo codes:');
      store.listPromoCodes().forEach(p =>
        console.log(`  ${p.code}  ${p.discount}% off  max ${p.maxUses} uses  used ${p.uses}x`)
      );
      if (store.listPromoCodes().length === 0) console.log('  (none)');
      break;
    }
    case 'orders': {
      console.log('Recent orders:');
      store.listTransactions(25).forEach(t => {
        console.log(
          `  #${t.id} ${t.orderCode}  ${t.accountName}  $${t.amount.toFixed(2)}  ` +
          `${t.promoCode ? 'promo:' + t.promoCode : ''}  ${t.createdAt}  ` +
          `notified=${t.notified ? 'yes' : 'no'}`
        );
      });
      if (store.listTransactions(25).length === 0) console.log('  (none)');
      break;
    }
    case 'order': {
      const id = args[0];
      const tx = store.getOrder(id);
      if (!tx) return console.log('Order not found.');
      console.log(JSON.stringify(tx, null, 2));
      break;
    }
    case 'notify': {
      const id = args[0];
      const tx = store.getOrder(id);
      if (!tx) return console.log('Order not found.');
      if (tx.notified) return console.log('Order already notified to Discord.');
      if (!webhookUrl) return console.log('No webhookUrl in config.json.');
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `Order ${tx.orderCode} (${tx.accountName}, $${tx.amount.toFixed(2)}) — please notify buyer.` })
      });
      if (res.ok) {
        store.markNotified(tx.id);
        console.log('Notification sent to Discord.');
      } else {
        console.log('Discord returned', res.status, await res.text());
      }
      break;
    }
    case 'accounts': {
      console.log('Accounts:');
      store.listAccounts(true).forEach(a =>
        console.log(`  #${a.id}  [${a.status}]  ${a.name}  $${a.price}  ${a.skins} skins`)
      );
      break;
    }
    case 'restore': {
      const id = Number(args[0]);
      if (!store.restoreAccount(id)) return console.log('Account not found.');
      console.log(`Account #${id} restored to available.`);
      break;
    }
    case 'import': {
      const file = args[0];
      if (!file) return console.log('Usage: node admin.js import <file.json>');
      const raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
      const list = Array.isArray(raw) ? raw : raw.accounts;
      list.forEach(a => store.addAccount(a));
      console.log(`Imported ${list.length} account(s).`);
      break;
    }
    default:
      console.log(`
Ghxstly Store admin CLI
  node admin.js codegen <amount> <count>     Generate recharge codes
  node admin.js codes                          List unused recharge codes
  node admin.js promo <CODE> <pct> <maxUses>   Add/update a promo code
  node admin.js orders                         List recent orders
  node admin.js order <codeOrId>               Show one order
  node admin.js notify <codeOrId>              Re-send Discord notification for an order
  node admin.js accounts                       List all accounts
  node admin.js restore <id>                   Re-list a sold account
  node admin.js import <file.json>             Import accounts [{name, tier, tierVar, price, skins, ...}]
      `);
  }
}

main();