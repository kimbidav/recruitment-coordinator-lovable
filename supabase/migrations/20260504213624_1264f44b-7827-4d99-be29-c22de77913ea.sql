UPDATE agent_action_cards
SET payload = payload || jsonb_build_object(
  'suggested_slack_message',
  CASE WHEN kind = 'intro_stall'
    THEN 'Hey — wanted to see if ' || COALESCE(NULLIF(split_part(payload->>'candidate_name',' ',1),''),'the candidate') || ' got scheduled, or do I need to bump?'
    ELSE 'Hey — any feedback on ' || COALESCE(NULLIF(split_part(payload->>'candidate_name',' ',1),''),'the candidate') || ' from the interview? Happy to share notes from our side too.'
  END
)
WHERE status = 'open'
  AND COALESCE(payload->>'suggested_slack_message','') = '';