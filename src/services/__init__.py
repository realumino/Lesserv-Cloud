"""Package marker for the services layer.

Why this exists: services hold the business rules between routers (HTTP)
and db (SQL). Pure transformers (config_service, share_service) contain no
I/O at all; the others are async because they touch the conn.
"""
