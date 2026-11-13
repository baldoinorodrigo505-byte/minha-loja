// Função serverless da Vercel: cria a cobrança Pix na TiggerPay.
// A chave de API fica SOMENTE na variável de ambiente TIGGERPAY_API_KEY (nunca no navegador).
const PRODUTOS = require('./_produtos');

const API_URL = 'https://api.tiggerpayments.com/create-pix-duck';
const soDigitos = (s) => String(s || '').replace(/\D/g, '');

// Procura em profundidade um texto que passe no teste (a resposta da API pode ter campos aninhados).
function achar(obj, teste, prof = 0) {
  if (obj == null || prof > 6) return null;
  if (typeof obj === 'string') return teste(obj) ? obj : null;
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      const r = achar(obj[k], teste, prof + 1);
      if (r) return r;
    }
  }
  return null;
}
function acharImagemQr(obj, prof = 0) {
  if (obj == null || prof > 6) return null;
  if (typeof obj === 'string') return obj.startsWith('data:image') ? obj : null;
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'string' && /qr/i.test(k) && v.length > 200 && /^[A-Za-z0-9+/=\s]+$/.test(v)) {
        return 'data:image/png;base64,' + v.replace(/\s/g, '');
      }
      const r = acharImagemQr(v, prof + 1);
      if (r) return r;
    }
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ erro: 'Método não permitido.' });
  }

  const apiKey = process.env.TIGGERPAY_API_KEY;
  if (!apiKey) return res.status(500).json({ erro: 'Pagamento ainda não configurado.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ erro: 'Pedido inválido.' });

  // 1) Itens: o valor é SEMPRE calculado aqui, com os preços do servidor (ignora qualquer preço vindo do navegador).
  const itens = Array.isArray(body.itens) ? body.itens : [];
  if (!itens.length || itens.length > 30) return res.status(400).json({ erro: 'Carrinho vazio ou inválido.' });
  let totalCentavos = 0;
  const resumo = [];
  for (const it of itens) {
    const p = PRODUTOS[it && it.id];
    const qtd = Number(it && it.qtd);
    if (!p || !Number.isInteger(qtd) || qtd < 1 || qtd > 10) {
      return res.status(400).json({ erro: 'Item inválido no carrinho.' });
    }
    totalCentavos += Math.round(p.preco * 100) * qtd;
    resumo.push(`${qtd}x ${p.nome}`);
  }
  if (totalCentavos < 100) return res.status(400).json({ erro: 'Valor inválido.' });

  // 2) ID do jogador: obrigatório só para diamantes, passes e combos (contas e outros itens não pedem ID).
  const idJogador = soDigitos(body.idJogador).slice(0, 15);
  const precisaId = itens.some((it) => ['diamantes', 'passes', 'combo'].includes(PRODUTOS[it.id].cat));
  if (precisaId && !idJogador) return res.status(400).json({ erro: 'Informe o ID do jogador.' });
  if (idJogador && (idJogador.length < 6 || idJogador.length > 15)) return res.status(400).json({ erro: 'ID do jogador inválido.' });
  const pedido = 'LJ' + Date.now().toString(36).toUpperCase();

  // 3) Dados opcionais do cliente (o site não pede mais; se algum vier, é validado e repassado).
  const cl = body.cliente || {};
  const nome = String(cl.nome || '').trim().replace(/\s+/g, ' ') || (idJogador ? `Jogador ${idJogador}` : `Cliente ${pedido}`);
  const email = String(cl.email || '').trim();
  const celular = soDigitos(cl.celular);
  const cpf = soDigitos(cl.cpf);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ erro: 'E-mail inválido.' });
  if (celular && (celular.length < 10 || celular.length > 11)) return res.status(400).json({ erro: 'Celular inválido (use DDD + número).' });
  if (cpf && cpf.length !== 11) return res.status(400).json({ erro: 'CPF inválido.' });

  const descricao = (`Pedido ${pedido}` + (idJogador ? ` | ID ${idJogador}` : '') + ' | ' + resumo.join(', ')).slice(0, 140);

  try {
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: totalCentavos,
        description: descricao,
        api_key: apiKey,
        customer: { name: nome, ...(email ? { email } : {}), ...(celular ? { cellphone: celular } : {}), ...(cpf ? { taxId: cpf } : {}) }
      })
    });
    const texto = await r.text();
    let data = null;
    try { data = JSON.parse(texto); } catch (e) { /* resposta não é JSON */ }

    if (!r.ok || !data) {
      console.error('TiggerPay respondeu com erro', r.status, texto.slice(0, 400));
      return res.status(502).json({ erro: 'Não foi possível gerar o Pix agora. Tente novamente em instantes.' });
    }

    // O código "copia e cola" do Pix sempre começa com 000201.
    const copiaCola = achar(data, (s) => /^000201/.test(s) && s.length > 50);
    const imagem = acharImagemQr(data);
    if (!copiaCola && !imagem) {
      console.error('Resposta da TiggerPay sem QR Code/copia e cola:', texto.slice(0, 600));
      return res.status(502).json({ erro: 'O Pix foi gerado, mas não conseguimos exibir o código. Fale com o suporte.' });
    }
    return res.status(200).json({ pedido, total: totalCentavos / 100, copiaCola, imagem });
  } catch (e) {
    console.error('Falha ao chamar a TiggerPay:', e && e.message);
    return res.status(502).json({ erro: 'Não foi possível gerar o Pix agora. Tente novamente em instantes.' });
  }
};
