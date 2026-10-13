-- 기존 입력·캐시 읽기·출력 가격과 과거 호출 비용은 보존하고, 빠져 있던 쓰기 가격/사용량을 별도로 추가합니다.
ALTER TABLE ai_model_price
    ADD COLUMN cache_write_input_usd_per_million DECIMAL(12, 6) NULL,
    ADD COLUMN cache_write_12h_input_usd_per_million DECIMAL(12, 6) NULL,
    ADD CONSTRAINT chk_ai_model_price_cache_write CHECK (
        (cache_write_input_usd_per_million IS NULL OR cache_write_input_usd_per_million >= 0)
        AND (cache_write_12h_input_usd_per_million IS NULL OR cache_write_12h_input_usd_per_million >= 0)
    );

-- OpenAI prompt-caching 문서(2026-10-14): GPT-5.6 이후 30분 쓰기는 해당 처리 등급 입력가의 1.25배입니다.
-- 기존 가격의 새 차원만 보완합니다. 12시간 단가는 확인되지 않아 NULL로 유지합니다.
UPDATE ai_model_price
SET cache_write_input_usd_per_million = input_usd_per_million * 1.25
WHERE model_prefix IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna');

ALTER TABLE ai_usage_record
    ADD COLUMN cache_write_input_tokens BIGINT UNSIGNED NULL,
    ADD COLUMN cache_write_12h_input_tokens BIGINT UNSIGNED NULL,
    ADD INDEX ix_ai_usage_record_occurred_at (occurred_at),
    ADD CONSTRAINT chk_ai_usage_record_cache_write CHECK (
        COALESCE(cache_write_input_tokens, 0) <= input_tokens - cached_input_tokens
        AND COALESCE(cache_write_12h_input_tokens, 0) <= input_tokens - cached_input_tokens - COALESCE(cache_write_input_tokens, 0)
    );

-- 사용자·기능별 앱 기록과 중복 합산하지 않는 OpenAI 조직 Usage API 장부입니다.
-- Catalog/평가/직접 호출도 선택한 조직·프로젝트에 속하면 이 장부에 포함됩니다.
CREATE TABLE ai_provider_usage_daily (
    usage_date DATE NOT NULL,
    usage_kind VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    project_id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    model VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    service_tier VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    batch_kind TINYINT NOT NULL COMMENT '-1 unknown, 0 non-batch, 1 batch',
    call_count BIGINT UNSIGNED NOT NULL,
    input_tokens BIGINT UNSIGNED NOT NULL,
    cached_input_tokens BIGINT UNSIGNED NULL,
    cache_write_input_tokens BIGINT UNSIGNED NULL,
    cache_write_12h_input_tokens BIGINT UNSIGNED NULL,
    output_tokens BIGINT UNSIGNED NOT NULL,
    estimated_cost_usd DECIMAL(20, 10) NULL,
    price_id BIGINT UNSIGNED NULL,
    PRIMARY KEY (usage_date, usage_kind, project_id, model, service_tier, batch_kind),
    CONSTRAINT fk_ai_provider_usage_price FOREIGN KEY (price_id) REFERENCES ai_model_price (id),
    CONSTRAINT chk_ai_provider_usage_kind CHECK (usage_kind IN ('completions', 'embeddings')),
    CONSTRAINT chk_ai_provider_usage_batch CHECK (batch_kind IN (-1, 0, 1)),
    CONSTRAINT chk_ai_provider_usage_tokens CHECK (
        COALESCE(cached_input_tokens, 0) <= input_tokens
        AND COALESCE(cache_write_input_tokens, 0) <= input_tokens - COALESCE(cached_input_tokens, 0)
        AND COALESCE(cache_write_12h_input_tokens, 0) <= input_tokens - COALESCE(cached_input_tokens, 0) - COALESCE(cache_write_input_tokens, 0)
    ),
    CONSTRAINT chk_ai_provider_usage_cost CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 0건인 날짜도 성공적으로 조회했음을 남겨 미조회와 $0를 구분합니다.
-- UTC 날짜별 사용량과 비용을 같은 transaction에서 저장하며, 설정 범위가 바뀌면 과거 범위와 비교하지 않습니다.
CREATE TABLE ai_cost_sync_day (
    usage_date DATE NOT NULL,
    project_scope VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'empty means organization',
    actual_usd DECIMAL(20, 10) NOT NULL,
    fetched_at DATETIME(6) NOT NULL COMMENT 'UTC',
    PRIMARY KEY (usage_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 여러 인스턴스의 정기·수동 동기화 저장을 직렬화합니다. 나중에 끝난 오래된 수집이 최신 장부를 덮지 못하게 합니다.
CREATE TABLE ai_cost_sync_state (
    singleton_id TINYINT NOT NULL,
    started_at DATETIME(6) NOT NULL COMMENT 'UTC start time of the latest accepted collection',
    PRIMARY KEY (singleton_id),
    CONSTRAINT chk_ai_cost_sync_state_singleton CHECK (singleton_id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO ai_cost_sync_state (singleton_id, started_at) VALUES (1, '1970-01-01 00:00:00');
