import { patchWhatsAppUtils } from './whatsapp-compat.js';
it('удаляет внутренний ID MediaModel после сборки сообщения, повторная сборка идемпотентна',()=>{
  const src="const message = {};\n        // Bot's won't reply if canonicalUrl is set (linking)\n";
  const fixed=patchWhatsAppUtils(src);expect(fixed).toContain('delete message.__x_id;');expect(patchWhatsAppUtils(fixed)).toBe(fixed);
  expect(()=>patchWhatsAppUtils('changed')).toThrow('needs review');
});
