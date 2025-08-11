-- Garante que a tabela não exista antes de criar
DROP TABLE IF EXISTS agendamentos;

-- Criação da tabela principal de agendamentos
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

-- Adiciona comentários para facilitar o entendimento
COMMENT ON COLUMN agendamentos.numero_nota IS 'Chave principal para consulta do cliente';
COMMENT ON COLUMN agendamentos.data_original IS 'Data do primeiro agendamento, nunca muda';
COMMENT ON COLUMN agendamentos.data_atual IS 'Data válida no momento, atualizada no reagendamento';
COMMENT ON COLUMN agendamentos.status IS 'Status atual: agendado, reagendado, concluido';

-- Cria um índice para otimizar as buscas por número da nota
CREATE INDEX idx_numero_nota ON agendamentos (numero_nota);

-- Insere um dado de exemplo para teste
INSERT INTO agendamentos (numero_nota, numero_instalacao, responsavel_pelo_agendamento, localidade, data_original, periodo_original, data_atual, periodo_atual)
VALUES ('12345', '98765', 'João da Silva Teste', 'Criciuma', '2025-10-25', 'manha', '2025-10-25', 'manha');