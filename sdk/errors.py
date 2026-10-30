"""Public errors contain safe descriptions, never raw upstream exception text."""

from enum import StrEnum


class RetryPolicy(StrEnum):
    NEVER = "never"
    BOUNDED_READ = "bounded_read"
    QUERY_ORIGINAL = "query_original"
    REFRESH_STATE = "refresh_state"
    HUMAN_REQUIRED = "human_required"


class BackendError(Exception):
    def __init__(self, code: str, message: str, *,
                 retry_policy: RetryPolicy = RetryPolicy.NEVER,
                 request_id: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retry_policy = RetryPolicy(retry_policy)
        self.request_id = request_id

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message,
                "retry_policy": self.retry_policy.value, "request_id": self.request_id}


class ContractError(BackendError):
    def __init__(self, message: str, *, code: str = "invalid_contract"):
        super().__init__(code, message)
