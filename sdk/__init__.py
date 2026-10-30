"""Public facade for complete conversation backends; no native execution loop."""

from .contracts import BackendDescriptor, ConversationRef, ResourceRef
from .errors import BackendError, ContractError
from .manifest import load_package, validate_descriptor, validate_event

__all__ = [
    "BackendDescriptor", "ConversationRef", "ResourceRef", "BackendError",
    "ContractError", "load_package", "validate_descriptor", "validate_event",
]
