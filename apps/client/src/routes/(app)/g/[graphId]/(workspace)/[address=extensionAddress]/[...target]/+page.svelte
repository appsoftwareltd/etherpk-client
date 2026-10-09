<!-- An extension View's address page: the workspace is the (workspace) layout; nothing here.
     A Built-in Extension declares the address in its manifest (ADR 0121), and GraphWorkspace reads
     params.address and params.target on real navigations (deep link / popstate) and asks the
     extension host's address book which View they name, as it reads params.concept for a
     Document URL. The target is empty for a View with one per graph. -->
