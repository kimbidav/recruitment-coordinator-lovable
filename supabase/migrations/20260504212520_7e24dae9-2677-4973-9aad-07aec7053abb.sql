UPDATE public.agent_action_cards
SET payload = payload - 'suggested_slack_message' - 'suggested_email_subject' - 'suggested_email_body',
    updated_at = now()
WHERE status = 'open';