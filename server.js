// --- Importação dos Módulos ---
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

// --- Configuração Inicial ---
const app = express();
const PORT = process.env.PORT || 3000;

// --- Conexão com o Banco de Dados (PostgreSQL) ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// --- Função para Inicializar o Banco de Dados ---
async function inicializarDB() {
  const client = await pool.connect();
  try {
    const tableExists = await client.query("SELECT to_regclass('public.agendamentos')");
    if (!tableExists.rows || tableExists.rows.length === 0 || tableExists.rows[0].to_regclass === null) {
      console.log("Tabela 'agendamentos' não encontrada. Criando tabela...");
      await client.query(`
        CREATE TABLE agendamentos (
          id SERIAL PRIMARY KEY,
          numero_nota VARCHAR(255) NOT NULL UNIQUE,
          numero_instalacao VARCHAR(255) NOT NULL,
          responsavel_pelo_agendamento VARCHAR(255) NOT NULL,
          localidade VARCHAR(50) NOT NULL,
          data_original DATE NOT NULL,
          periodo_original VARCHAR(10) NOT NULL,
          data_atual DATE NOT NULL,
          periodo_atual VARCHAR(10) NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'agendado',
          quantidade_reagendamentos INT NOT NULL DEFAULT 0,
          reagendado_em TIMESTAMP,
          criado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log("Tabela 'agendamentos' criada com sucesso.");
    } else {
      console.log("Tabela 'agendamentos' já existe.");
    }
  } catch (err) {
    console.error("Erro durante a inicialização do banco de dados:", err);
    throw err;
  } finally {
    client.release();
  }
}

// --- Middlewares ---
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- Funções Auxiliares de Data ---
function adicionarDiasUteis(dataInicial, dias) {
    let data = new Date(dataInicial);
    let diasAdicionados = 0;
    while (diasAdicionados < dias) {
        data.setDate(data.getDate() + 1);
        const diaDaSemana = data.getDay(); // usar getDay (local) para consistência
        if (diaDaSemana !== 0 && diaDaSemana !== 6) diasAdicionados++;
    }
    data.setHours(0,0,0,0);
    return data;
}

// --- ROTAS DA API ---

// [GET] Rota de disponibilidade
app.get('/api/disponibilidade/:localidade', async (req, res) => {
    const { localidade } = req.params;
    try {
        // contamos agendamentos não concluídos por data e período
        const result = await pool.query(
            `SELECT data_atual, periodo_atual, COUNT(*) as count
             FROM agendamentos
             WHERE localidade = $1 AND status != 'concluido' AND data_atual >= CURRENT_DATE
             GROUP BY data_atual, periodo_atual`,
            [localidade]
        );
        
        const turnosIndisponiveis = {};
        result.rows.forEach(row => {
            // garante que o count seja número
            const cnt = parseInt(row.count, 10) || 0;
            // formatar data como YYYY-MM-DD usando toISOString (UTC)
            const dataObj = new Date(row.data_atual);
            const dataFormatada = dataObj.toISOString().split('T')[0];
            if (cnt >= 2) {
                if (!turnosIndisponiveis[dataFormatada]) {
                    turnosIndisponiveis[dataFormatada] = [];
                }
                turnosIndisponiveis[dataFormatada].push(row.periodo_atual);
            } else {
                // se houver 1 vaga ocupada no período, ainda consideramos o período indisponível apenas se cnt >= 2
                // aqui mantemos a lógica de bloquear apenas quando cnt >= 2 (limite de 2 vagas por período)
            }
        });

        // diasLotados = datas para as quais ambos os períodos estão indisponíveis
        const diasLotados = Object.keys(turnosIndisponiveis).filter(
            data => turnosIndisponiveis[data].length >= 2
        );

        res.json({ turnosIndisponiveis, diasLotados });
    } catch (error) {
        console.error('Erro ao buscar disponibilidade:', error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
});


// [POST] Criar um novo agendamento
app.post('/api/agendamentos', async (req, res) => {
    const { numero_nota, numero_instalacao, responsavel_pelo_agendamento, localidade, data, periodo } = req.body;

    const notaPattern = /^(0?709)\d{8}$/;
    if (!notaPattern.test(numero_nota)) {
        return res.status(400).json({ message: 'A nota deve começar com 709 e conter 11 dígitos. Por favor, confirme o número informado.' });
    }

    if (!numero_nota || !data || !periodo || !localidade || !responsavel_pelo_agendamento || !numero_instalacao) {
        return res.status(400).json({ message: 'Todos os campos são obrigatórios.' });
    }

    // interpreta data no formato YYYY-MM-DD
    const dataSelecionada = new Date(data + "T00:00:00");
    const hoje = new Date();
    const dataMaxima = new Date();
    dataMaxima.setDate(hoje.getDate() + 30);

    if (dataSelecionada > dataMaxima) {
        return res.status(400).json({ message: 'O agendamento não pode ser feito com mais de 30 dias de antecedência.' });
    }
    
    const diaDaSemana = dataSelecionada.getDay();
    if (diaDaSemana === 0 || diaDaSemana === 6) {
        return res.status(400).json({ message: 'Agendamentos são permitidos apenas em dias úteis.' });
    }

    const dataMinima = adicionarDiasUteis(new Date(), 2);
    if (dataSelecionada < dataMinima) {
        return res.status(400).json({ message: 'O agendamento deve ter no mínimo 3 dias úteis de antecedência.' });
    }

    try {
        const client = await pool.connect();
        const notaExistente = await client.query('SELECT 1 FROM agendamentos WHERE numero_nota = $1', [numero_nota]);
        if (notaExistente.rowCount > 0) {
            client.release();
            return res.status(409).json({ message: 'Já existe um agendamento com este Número de Nota.' });
        }
        
        const vagasRes = await client.query(
            'SELECT COUNT(*) as cnt FROM agendamentos WHERE data_atual = $1 AND periodo_atual = $2 AND localidade = $3',
            [data, periodo, localidade]
        );
        const vagas = parseInt(vagasRes.rows[0].cnt, 10) || 0;
        if (vagas >= 2) {
            client.release();
            return res.status(409).json({ message: 'Período indisponível. O limite de vagas foi atingido.' });
        }

        const result = await client.query(
            `INSERT INTO agendamentos (numero_nota, numero_instalacao, responsavel_pelo_agendamento, localidade, data_original, periodo_original, data_atual, periodo_atual)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [numero_nota, numero_instalacao, responsavel_pelo_agendamento, localidade, data, periodo, data, periodo]
        );
        
        client.release();
        res.status(201).json({ message: 'Agendamento criado com sucesso!', agendamento: result.rows[0] });

    } catch (error) {
        console.error('Erro ao criar agendamento:', error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
});

// [GET] Consultar um agendamento por número da nota
app.get('/api/agendamentos/:nota', async (req, res) => {
    const { nota } = req.params;
    try {
        const result = await pool.query('SELECT * FROM agendamentos WHERE numero_nota = $1', [nota]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Nenhum agendamento encontrado para a nota informada.' });
        }
        
        const agendamento = result.rows[0];
        const podeReagendar = agendamento.quantidade_reagendamentos === 0;
        
        let motivoBloqueio = '';
        if (!podeReagendar) {
            motivoBloqueio = 'O limite de 1 reagendamento por nota já foi atingido.';
        }
        
        const dataAgendamento = new Date(agendamento.data_atual);
        const dataMinimaParaReagendar = adicionarDiasUteis(new Date(), 2);
        if (podeReagendar && agendamento.status !== 'concluido' && dataAgendamento < dataMinimaParaReagendar) {
             motivoBloqueio = 'O prazo para reagendamento (3 dias úteis de antecedência) expirou.';
        }

        res.json({ 
            agendamento, 
            podeReagendar: podeReagendar && !motivoBloqueio,
            motivoBloqueio 
        });

    } catch (error) {
        console.error('Erro ao consultar agendamento:', error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
});

// [POST] Reagendar uma inspeção
app.post('/api/agendamentos/:nota/reagendar', async (req, res) => {
    const { nota } = req.params;
    const { data, periodo } = req.body;

    if (!data || !periodo) {
        return res.status(400).json({ message: 'Nova data e período são obrigatórios.' });
    }
    
    const dataSelecionada = new Date(data + "T00:00:00");
    if (dataSelecionada.getDay() === 0 || dataSelecionada.getDay() === 6) {
        return res.status(400).json({ message: 'Reagendamentos são permitidos apenas em dias úteis.' });
    }
    const dataMinima = adicionarDiasUteis(new Date(), 2);
    if (dataSelecionada < dataMinima) {
        return res.status(400).json({ message: 'O reagendamento deve ter no mínimo 3 dias úteis de antecedência.' });
    }

    try {
        const client = await pool.connect();
        const agendamentoOriginal = await client.query('SELECT * FROM agendamentos WHERE numero_nota = $1', [nota]);
        if (agendamentoOriginal.rowCount === 0) {
            client.release();
            return res.status(404).json({ message: 'Agendamento não encontrado.' });
        }
        const ag = agendamentoOriginal.rows[0];
        if (ag.quantidade_reagendamentos > 0) {
            client.release();
            return res.status(403).json({ message: 'Este agendamento não pode mais ser reagendado.' });
        }

        const vagasRes = await client.query(
            'SELECT COUNT(*) as cnt FROM agendamentos WHERE data_atual = $1 AND periodo_atual = $2 AND localidade = $3',
            [data, periodo, ag.localidade]
        );
        const vagas = parseInt(vagasRes.rows[0].cnt, 10) || 0;
        if (vagas >= 2) {
            client.release();
            return res.status(409).json({ message: 'Período indisponível. O limite de vagas foi atingido.' });
        }

        const result = await client.query(
            `UPDATE agendamentos 
             SET data_atual = $1, periodo_atual = $2, status = 'reagendado', quantidade_reagendamentos = 1, reagendado_em = NOW()
             WHERE numero_nota = $3 RETURNING *`,
            [data, periodo, nota]
        );

        client.release();
        res.json({ message: 'Reagendamento concluído com sucesso!', agendamento: result.rows[0] });

    } catch (error) {
        console.error('Erro ao reagendar:', error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
});


// --- ROTAS DO BACKOFFICE (Protegidas) ---
const BACKOFFICE_PASSWORD = process.env.BACKOFFICE_PASSWORD || 'celesc123';
const JWT_SECRET = process.env.JWT_SECRET || 'segredo-super-secreto';

app.post('/api/login', (req, res) => {
    const { senha } = req.body;
    if (senha === BACKOFFICE_PASSWORD) {
        const token = jwt.sign({ user: 'celesc_admin' }, JWT_SECRET, { expiresIn: '8h' });
        res.json({ message: 'Login bem-sucedido', token });
    } else {
        res.status(401).json({ message: 'Senha incorreta.' });
    }
});

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
}

app.get('/api/backoffice/agendamentos', authenticateToken, async (req, res) => {
    const { localidade, status, data } = req.query;
    let query = 'SELECT * FROM agendamentos';
    let conditions = [];
    let params = [];
    let paramIndex = 1;

    if (localidade) {
        conditions.push(`localidade = $${paramIndex++}`);
        params.push(localidade);
    }
    if (status) {
        conditions.push(`status = $${paramIndex++}`);
        params.push(status);
    }
    if (data) {
        conditions.push(`data_atual = $${paramIndex++}`);
        params.push(data);
    }

    if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY data_atual DESC, id DESC';

    try {
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (error) {
        console.error('Erro ao buscar agendamentos para backoffice:', error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
});

app.post('/api/backoffice/agendamentos/:nota/concluir', authenticateToken, async (req, res) => {
    const { nota } = req.params;
    try {
        const result = await pool.query(
            "UPDATE agendamentos SET status = 'concluido' WHERE numero_nota = $1 RETURNING *",
            [nota]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Agendamento não encontrado.' });
        }
        res.json({ message: 'Agendamento marcado como concluído.', agendamento: result.rows[0] });
    } catch (error) {
        console.error('Erro ao concluir agendamento:', error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
});

// [DELETE] Excluir um agendamento
app.delete('/api/backoffice/agendamentos/:nota', authenticateToken, async (req, res) => {
    const { nota } = req.params;
    try {
        const result = await pool.query('DELETE FROM agendamentos WHERE numero_nota = $1', [nota]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Agendamento não encontrado para exclusão.' });
        }
        res.json({ message: `Agendamento da nota ${nota} foi excluído com sucesso.` });
    } catch (error) {
        console.error('Erro ao excluir agendamento:', error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
});

// [POST] Excluir múltiplos agendamentos
app.post('/api/backoffice/agendamentos/excluir-massa', authenticateToken, async (req, res) => {
    const { notas } = req.body;
    if (!notas || !Array.isArray(notas) || notas.length === 0) {
        return res.status(400).json({ message: 'Nenhuma nota fornecida para exclusão.' });
    }
    try {
        const result = await pool.query('DELETE FROM agendamentos WHERE numero_nota = ANY($1::text[])', [notas]);
        res.json({ message: `${result.rowCount} agendamentos foram excluídos com sucesso.` });
    } catch (error) {
        console.error('Erro ao excluir múltiplos agendamentos:', error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
});


// --- Iniciar o Servidor ---
app.listen(PORT, async () => {
  try {
    await inicializarDB();
    console.log(`Servidor rodando na porta ${PORT}`);
  } catch (err) {
    console.error("Falha ao iniciar o servidor.", err);
    process.exit(1);
  }
});