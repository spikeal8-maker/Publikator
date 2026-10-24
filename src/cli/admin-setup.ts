import { config } from '../config.js';
import { db, migrate } from '../db.js';
import { createAdminSetupGrant } from '../admin-auth.js';

migrate();
try {
  const recovery = process.argv.includes('--recover');
  const mode = recovery ? 'RECOVER' : 'INITIAL';
  const token = createAdminSetupGrant(mode);
  const localAddress = `http://127.0.0.1:${process.env.PUBLIKATOR_PORT || config.port}`;
  const base = (config.publicBaseUrl || localAddress).replace(/\/$/, '');
  const fragment = recovery ? 'admin-recover' : 'admin-setup';
  process.stdout.write('\nОткройте ссылку на компьютере администратора. Она действительна 10 минут и только один раз.\n');
  process.stdout.write(`${base}/#${fragment}=${token}\n\n`);
  process.stdout.write('Не публикуйте ссылку. После регистрации обычный вход работает по логину и паролю.\n');
} finally {
  db.close();
}
