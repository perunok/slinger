<script lang="ts">
  export let type: 'button' | 'reset' | 'submit' = 'button';
  export let disabled = false;
  export let variant: 'primary' | 'secondary' | 'danger' = 'primary';

  let classes = {
    primary: 'bg-blue-600 text-white hover:bg-blue-700',
    secondary: 'bg-gray-200 text-gray-800 hover:bg-gray-300',
    danger: 'bg-red-600 text-white hover:bg-red-700'
  };
</script>

<button
  {type}
  {disabled}
  class="px-4 py-2 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 {classes[variant]} {disabled ? 'opacity-50 cursor-not-allowed' : ''}"
  on:click
>
  <slot />
</button>