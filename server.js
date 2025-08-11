import express from 'express';
import cors from 'cors';
import pg from 'pg';

const app = express();
app.use(cors());
app.use(express.json());

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL
});

app.get('/api/disponibilidade/:localidade', async (req, res) => {
    const { localidade } = req.params;
    try {
        const result = await pool.query(
            `SELECT to_char(data_atual, 'YYYY-MM-DD') as data_atual, periodo_atual, COUNT(*) as count
             FROM agendamentos
             WHERE localidade = $1 AND status != 'concluido' AND data_atual >= CURRENT_DATE
             GROUP BY data_atual, periodo_atual`,
            [localidade]
        );

        const turnosIndisponiveis = {};
        const diasLotados = new Set();

        result.rows.forEach(row => {
            const cnt = parseInt(row.count, 10) || 0;
            const dataFormatada = String(row.data_atual);

            if (cnt >= 2) {
                if (!turnosIndisponiveis[dataFormatada]) {
                    turnosIndisponiveis[dataFormatada] = [];
                }
                turnosIndisponiveis[dataFormatada].push(row.periodo_atual);
            }
        });

        Object.keys(turnosIndisponiveis).forEach(data => {
            if (turnosIndisponiveis[data].length >= 2) {
                diasLotados.add(data);
            }
        });

        res.json({
            diasLotados: Array.from(diasLotados),
            turnosIndisponiveis
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: "Erro ao obter disponibilidade" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});