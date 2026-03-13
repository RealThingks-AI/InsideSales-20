-- Create campaign-materials storage bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('campaign-materials', 'campaign-materials', false)
ON CONFLICT (id) DO NOTHING;

-- RLS policies for campaign-materials bucket
CREATE POLICY "Authenticated users can upload campaign materials"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'campaign-materials');

CREATE POLICY "Authenticated users can view campaign materials"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'campaign-materials');

CREATE POLICY "Users can delete their own campaign materials"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'campaign-materials');
